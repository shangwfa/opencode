// 悬空 tool part 善后 + 死实例行清扫。
// 触发方：question/permission service 的轮询 fiber（每 ~30s 附带执行一次）。
// 三分支语义（见 docs/hitl-persistence-design.md §4.5）：
//   pending 未答     → part 写 error（实例重启文案），行 closed(instance-restart)
//   replied 未消费   → part 写 completed（用户答案回填），行 closed(answered-delivered)
//   rejected 未消费  → part 写 error（用户拒绝文案），行保持 rejected
import { and, eq, sql } from "drizzle-orm"
import { Effect, Option } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import type { ToolPart } from "@opencode-ai/core/v1/session"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@/storage/db"
import { PartTable } from "@/session/session.pg"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { EventV2Bridge } from "@/event-v2-bridge"
import { HitlStore } from "./store"

const log = Log.create({ service: "hitl.salvage" })

interface ToolLocator {
  messageID: string
  callID: string
}

function toolOf(payload: Record<string, unknown>): ToolLocator | undefined {
  const tool = payload["tool"]
  if (tool === undefined || typeof tool !== "object" || tool === null) return
  const messageID = (tool as Record<string, unknown>)["messageID"]
  const callID = (tool as Record<string, unknown>)["callID"]
  if (typeof messageID !== "string" || typeof callID !== "string") return
  return { messageID, callID }
}

function answerOutput(row: HitlStore.Row): string {
  if (row.kind === "permission") {
    const reply = row.result?.["reply"]
    return reply === "always" ? "User approved (always)" : "User approved (once)"
  }
  const answers = row.result?.["answers"]
  if (!Array.isArray(answers)) return "User answered"
  const text = answers.map((answer) => (Array.isArray(answer) ? answer.join(", ") : String(answer))).join("; ")
  return `User answered: ${text}`
}

function errorOutput(row: HitlStore.Row): string {
  if (row.status === "rejected") return "The user rejected this request."
  const subject = row.kind === "question" ? "Question" : "Permission request"
  return `${subject} closed: the opencode instance restarted before the user responded. Ask again if still needed.`
}

// 把行对应的消息树 tool part 从 running 迁到终态。part 已非 running（run 正常写完）时 CAS 不命中，安全跳过。
// 纯 promise：必须在外层 Database.transaction 的同一 async 链内调用，part CAS 与请求行 claim 共享事务。
interface SalvageResult {
  complete: boolean
  part?: ToolPart
}

type SalvageDb = Parameters<Parameters<typeof Database.transaction>[0]>[0]

async function salvageRow(db: SalvageDb, row: HitlStore.Row): Promise<SalvageResult> {
  const locator = toolOf(row.payload)
  if (locator === undefined) return { complete: true }
  const partRows = await db
    .select({
      id: PartTable.id,
      message_id: PartTable.message_id,
      session_id: PartTable.session_id,
      data: PartTable.data,
    })
    .from(PartTable)
    .where(
      and(
        eq(PartTable.session_id, row.session_id as SessionID),
        eq(PartTable.message_id, locator.messageID as MessageID),
        sql`${PartTable.data}->>'callID' = ${locator.callID}`,
      ),
    )
    .limit(1)
    .all()
  const target = partRows[0]
  if (target === undefined) return { complete: false }
  const part = target.data as unknown as ToolPart
  if (part.state.status !== "running") return { complete: true }
  const running = part.state
  const start = running.time.start
  const end = Date.now()
  const replied = row.status === "replied"
  const next: ToolPart = replied
    ? {
        ...part,
        state: {
          status: "completed",
          input: running.input,
          output: answerOutput(row),
          title: part.tool,
          metadata: { ...(running.metadata ?? {}), hitl: { salvaged: true } },
          time: { start, end },
        },
      }
    : {
        ...part,
        state: {
          status: "error",
          input: running.input,
          error: errorOutput(row),
          metadata: { ...(running.metadata ?? {}), hitl: { salvaged: true } },
          time: { start, end },
        },
      }
  const { id: _id, sessionID: _sid, messageID: _mid, ...data } = next
  const updated = await db
    .update(PartTable)
    .set({ data, time_updated: end })
    .where(
      and(
        eq(PartTable.id, target.id),
        sql`${PartTable.data}->>'type' = 'tool'`,
        sql`${PartTable.data}->'state'->>'status' = 'running'`,
        sql`(${PartTable.data}->'state'->'time'->>'start')::bigint = ${start}`,
      ),
    )
    .returning({ id: PartTable.id })
    .all()
  if (updated.length === 0) return { complete: true }
  return {
    complete: true,
    part: { ...next, id: target.id, sessionID: target.session_id, messageID: target.message_id },
  }
}

export interface SweepStats {
  sweptPending: number
  answeredBackfilled: number
  archivedFinal: number
}

// 单个 kind 的完整清扫：死实例 pending → closed；已决未消费 → part 善后 + 归档；顺带 retention。
// span attributes 对齐 watchdog 风格（hitl.swept_pending/answered_backfilled/archived_final/duration_ms）。
export const sweepKind = (events: EventV2Bridge.Service["Service"], kind: HitlStore.Kind, directory: string) =>
  Effect.gen(function* () {
    const t0 = Date.now()
    // Spans only exist under a tracing parent (the poll fiber's Effect.fn);
    // degrade to a no-op when swept directly (tests, scripts).
    const span = yield* Effect.option(Effect.currentSpan)
    const attribute = (key: string, value: string | number | boolean) => {
      if (Option.isSome(span)) span.value.attribute(key, value)
    }
    let sweptPending = 0
    let answeredBackfilled = 0
    let archivedFinal = 0

    const dead = yield* Effect.tryPromise({
      try: () => HitlStore.deadPending(kind, directory),
      catch: (error) => new Error(`hitl sweep pending query failed: ${String(error)}`),
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("hitl sweep pending query failed", { cause: String(cause) }).pipe(Effect.as([])),
      ),
    )
    for (const row of dead) {
      const result = yield* Effect.tryPromise({
        try: () =>
          Database.transaction(async (db) => {
            const claimed = await HitlStore.claimExpiredPending(row.id, kind, directory)
            if (claimed === undefined) return
            const salvaged = await salvageRow(db, claimed)
            if (!salvaged.complete) throw new Error(`hitl part not found for ${row.id}`)
            return { row: claimed, part: salvaged.part }
          }),
        catch: (error) => new Error(`hitl sweep close failed for ${row.id}: ${String(error)}`),
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("hitl sweep close failed", { id: row.id, cause: String(cause) }).pipe(Effect.as(undefined)),
        ),
      )
      if (result === undefined) continue
      sweptPending += 1
      if (result.part !== undefined) {
        yield* events.publish(SessionV1.Event.PartUpdated, {
          sessionID: result.part.sessionID,
          part: result.part,
          time: Date.now(),
        })
      }
      log.warn("salvaged hitl part", { id: row.id, kind, sessionID: row.session_id, outcome: "closed" })
    }

    const final = yield* Effect.tryPromise({
      try: () => HitlStore.deadFinal(kind, directory),
      catch: (error) => new Error(`hitl sweep final query failed: ${String(error)}`),
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("hitl sweep final query failed", { cause: String(cause) }).pipe(Effect.as([])),
      ),
    )
    for (const row of final) {
      if (row.status !== "replied" && row.status !== "rejected") continue
      const result = yield* Effect.tryPromise({
        try: () =>
          Database.transaction(async (db) => {
            const archived = await HitlStore.casCloseFinal(
              row.id,
              kind,
              directory,
              row.status as "replied" | "rejected",
              row.status === "replied" ? "answered-delivered" : "decision-delivered",
            )
            if (archived.length === 0) return
            const salvaged = await salvageRow(db, row)
            if (!salvaged.complete) throw new Error(`hitl part not found for ${row.id}`)
            return salvaged
          }),
        catch: (error) => new Error(`hitl sweep archive failed for ${row.id}: ${String(error)}`),
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("hitl sweep archive failed", { id: row.id, cause: String(cause) }).pipe(Effect.as(undefined)),
        ),
      )
      if (result === undefined) continue
      if (result.part !== undefined) {
        yield* events.publish(SessionV1.Event.PartUpdated, {
          sessionID: result.part.sessionID,
          part: result.part,
          time: Date.now(),
        })
        log.warn("salvaged hitl part", { id: row.id, kind, sessionID: row.session_id, outcome: row.status })
      }
      if (result.part !== undefined && row.status === "replied") answeredBackfilled += 1
      archivedFinal += 1
    }

    yield* Effect.tryPromise({
      try: () => HitlStore.retention(directory),
      catch: (error) => new Error(`hitl retention failed: ${String(error)}`),
    }).pipe(Effect.catchCause((cause) => Effect.logError("hitl retention failed", { cause: String(cause) })))

    attribute("hitl.kind", kind)
    attribute("hitl.swept_pending", sweptPending)
    attribute("hitl.answered_backfilled", answeredBackfilled)
    attribute("hitl.archived_final", archivedFinal)
    attribute("hitl.duration_ms", Date.now() - t0)

    return { sweptPending, answeredBackfilled, archivedFinal } satisfies SweepStats
  })

export * as HitlSalvage from "./salvage"
