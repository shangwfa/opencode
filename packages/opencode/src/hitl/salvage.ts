// 悬空 tool part 善后 + 死实例行清扫。
// 触发方：question/permission service 的轮询 fiber（每 ~30s 附带执行一次）。
// 三分支语义（见 docs/hitl-persistence-design.md §4.5）：
//   pending 未答     → part 写 error（实例重启文案），行 closed(instance-restart)
//   replied 未消费   → part 写 completed（用户答案回填），行 closed(answered-delivered)
//   rejected 未消费  → part 写 error（用户拒绝文案），行保持 rejected
import { and, eq, sql } from "drizzle-orm"
import { Effect } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import type { ToolPart } from "@opencode-ai/core/v1/session"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@/storage/db"
import { PartTable } from "@/session/session.pg"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SessionTools } from "@/session/mark-timed-out"
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
const salvageRow = (events: EventV2Bridge.Service["Service"], row: HitlStore.Row) =>
  Effect.gen(function* () {
    const locator = toolOf(row.payload)
    if (locator === undefined) return false
    const partRows = yield* Effect.tryPromise({
      try: (): Promise<Array<{ id: PartID; message_id: MessageID; session_id: SessionID; data: unknown }>> =>
        Database.Client()
          .select({ id: PartTable.id, message_id: PartTable.message_id, session_id: PartTable.session_id, data: PartTable.data })
          .from(PartTable)
          .where(
            and(
              eq(PartTable.session_id, row.session_id as SessionID),
              eq(PartTable.message_id, locator.messageID as MessageID),
              sql`${PartTable.data}->>'callID' = ${locator.callID}`,
              sql`${PartTable.data}->'state'->>'status' = 'running'`,
            ),
          )
          .limit(1)
          .all(),
      catch: (error) => new Error(`hitl salvage locate failed for ${row.id}: ${String(error)}`),
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("hitl salvage locate failed", { id: row.id, cause: String(cause) }).pipe(Effect.as(undefined)),
      ),
    )
    const target = partRows?.[0]
    if (target === undefined) return false
    // 定位条件已限定 running，这里按 running state 收窄取 start/input/metadata
    const part = target.data as unknown as ToolPart
    const running = part.state as unknown as { time: { start: number }; input: Record<string, unknown>; metadata?: Record<string, unknown> }
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
    const done = yield* SessionTools.transitionRunningTool(
      { ...next, id: target.id, sessionID: target.session_id, messageID: target.message_id },
      start,
    )
    if (!done) return false
    yield* events.publish(SessionV1.Event.PartUpdated, {
      sessionID: target.session_id,
      part: { ...next, id: target.id, sessionID: target.session_id, messageID: target.message_id },
      time: end,
    })
    log.warn("salvaged hitl part", {
      id: row.id,
      kind: row.kind,
      sessionID: row.session_id,
      outcome: replied ? "answered-backfill" : row.status,
    })
    return true
  })

export interface SweepStats {
  sweptPending: number
  answeredBackfilled: number
  archivedFinal: number
}

// 单个 kind 的完整清扫：死实例 pending → closed；已决未消费 → part 善后 + 归档；顺带 retention。
export const sweepKind = (events: EventV2Bridge.Service["Service"], kind: HitlStore.Kind, directory: string) =>
  Effect.gen(function* () {
    const t0 = Date.now()
    const before = t0 - HitlStore.SWEEP_GRACE_MS
    let sweptPending = 0
    let answeredBackfilled = 0
    let archivedFinal = 0

    const dead = yield* Effect.tryPromise({
      try: () => HitlStore.deadPending(kind, directory, before),
      catch: (error) => new Error(`hitl sweep pending query failed: ${String(error)}`),
    }).pipe(Effect.catchCause((cause) => Effect.logError("hitl sweep pending query failed", { cause: String(cause) }).pipe(Effect.as([]))))
    for (const row of dead) {
      yield* salvageRow(events, row)
      const outcome = yield* Effect.tryPromise({
        try: () => HitlStore.casTransition(row.id, kind, { status: "closed", closeReason: "instance-restart" }),
        catch: (error) => new Error(`hitl sweep close failed for ${row.id}: ${String(error)}`),
      }).pipe(Effect.catchCause((cause) => Effect.logError("hitl sweep close failed", { id: row.id, cause: String(cause) }).pipe(Effect.as(undefined))))
      if (outcome?.updated !== undefined) sweptPending += 1
    }

    const final = yield* Effect.tryPromise({
      try: () => HitlStore.deadFinal(kind, directory, before),
      catch: (error) => new Error(`hitl sweep final query failed: ${String(error)}`),
    }).pipe(Effect.catchCause((cause) => Effect.logError("hitl sweep final query failed", { cause: String(cause) }).pipe(Effect.as([]))))
    for (const row of final) {
      const salvaged = yield* salvageRow(events, row)
      if (salvaged && row.status === "replied") answeredBackfilled += 1
      if (row.status === "replied") {
        yield* Effect.tryPromise({
          try: () => HitlStore.casCloseReplied(row.id, "answered-delivered"),
          catch: (error) => new Error(`hitl sweep archive failed for ${row.id}: ${String(error)}`),
        }).pipe(Effect.catchCause((cause) => Effect.logError("hitl sweep archive failed", { id: row.id, cause: String(cause) })))
      }
      archivedFinal += 1
    }

    yield* Effect.tryPromise({
      try: () => HitlStore.retention(t0 - HitlStore.RETENTION_MS),
      catch: (error) => new Error(`hitl retention failed: ${String(error)}`),
    }).pipe(Effect.catchCause((cause) => Effect.logError("hitl retention failed", { cause: String(cause) })))

    return { sweptPending, answeredBackfilled, archivedFinal } satisfies SweepStats
  })
