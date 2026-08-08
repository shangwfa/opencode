import { Context, Effect, Layer, Option } from "effect"
import { SessionV1, type ToolPart, type ToolStateRunning } from "@opencode-ai/core/v1/session"
import { PartID, type SessionID } from "./schema"
import * as Log from "@opencode-ai/core/util/log"
import { SandboxProvider } from "@/tool/sandbox-provider"
import { Database } from "../storage/db"
import { PartTable } from "./session.pg"
import { and, eq, sql } from "drizzle-orm"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ToolExecution } from "./tool-execution"

const log = Log.create({ service: "session.tools" })

type StoredToolPart = Omit<ToolPart, "id" | "sessionID" | "messageID">
type StoredRunningToolPart = Omit<StoredToolPart, "state"> & { state: ToolStateRunning }
type ToolPartRow = Pick<typeof PartTable.$inferSelect, "id" | "session_id" | "message_id" | "data">
type LifecycleDb = {
  execute(query: ReturnType<typeof sql>): Promise<unknown>
  select(): {
    from(table: typeof PartTable): {
      where(condition: ReturnType<typeof eq>): {
        get(): Promise<ToolPartRow | undefined>
        all(): Promise<ToolPartRow[]>
      }
    }
  }
  update(table: typeof PartTable): {
    set(value: { data: StoredToolPart; time_updated: number }): {
      where(condition: ReturnType<typeof and>): {
        returning(input: { id: typeof PartTable.id }): {
          all(): Promise<Array<{ id: PartID }>>
        }
      }
    }
  }
}

export interface Interface {
  readonly markTimedOut: (input: {
    partID: PartID
    expectedStart: number
    timeoutMs: number
    now?: number
  }) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionTools") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const maybeSandbox = yield* Effect.serviceOption(SandboxProvider.Service)
    const events = yield* EventV2Bridge.Service

    const markTimedOut: Interface["markTimedOut"] = Effect.fn("SessionTools.markTimedOut")(function* (input) {
      const now = input.now ?? Date.now()
      const result = yield* Effect.tryPromise({
        try: () =>
          Database.transaction(
            async (tx: LifecycleDb) => {
              const initial = await tx.select().from(PartTable).where(eq(PartTable.id, input.partID)).get()
              if (!initial) return undefined
              if (Database.dialect === "pg") {
                await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${initial.message_id}))`)
              }
              const row = Database.dialect === "pg"
                ? await tx.select().from(PartTable).where(eq(PartTable.id, input.partID)).get()
                : initial
              const part = parseToolPart(row?.data)
              if (!row || !part) return undefined
              if (part.state.time.start !== input.expectedStart) return undefined
              if (now - part.state.time.start <= input.timeoutMs) return undefined
              const attempts = (await tx
                .select()
                .from(PartTable)
                .where(eq(PartTable.message_id, row.message_id))
                .all())
                .filter((item) => isWatchdogTimeout(item.data)).length + 1
              const eligible = attempts <= MAX_AGENT_RETRY_ATTEMPTS
              const requiresVerification = RETRY_WITH_VERIFICATION.has(part.tool)

              const updateData: StoredToolPart = {
                ...part,
                state: {
                  status: "error",
                  input: part.state.input,
                  error: [
                    `Tool execution timed out after ${Math.round(input.timeoutMs / 1000)}s (watchdog).`,
                    "The operation may have partially completed.",
                    eligible
                      ? requiresVerification
                        ? `Inspect the current state before retrying, then use a narrower or idempotent operation; retry ${attempts} of ${MAX_AGENT_RETRY_ATTEMPTS}.`
                        : `The code agent may retry with a narrower operation; retry ${attempts} of ${MAX_AGENT_RETRY_ATTEMPTS}.`
                      : `The code agent retry budget of ${MAX_AGENT_RETRY_ATTEMPTS} attempts is exhausted; report the failure instead of retrying.`,
                  ].join(" "),
                  metadata: {
                    ...(part.state.metadata ?? {}),
                    timeout: true,
                    retry: {
                      strategy: "agent",
                      eligible,
                      attempt: attempts,
                      maxAttempts: MAX_AGENT_RETRY_ATTEMPTS,
                      requiresVerification,
                    },
                  },
                  time: { start: part.state.time.start, end: now },
                },
              }
              const updated = await tx
                .update(PartTable)
                .set({ data: updateData, time_updated: now })
                .where(runningToolCasCondition(input.partID, input.expectedStart))
                .returning({ id: PartTable.id })
                .all()
              if (updated.length === 0) return undefined
              const result = { row, updateData }
              if (Database.dialect === "pg") {
                await Effect.runPromise(publishTimedOut(events, result, now))
              }
              return result
            },
            { behavior: "immediate" },
          ),
        catch: (error) => new Error(`mark timed out failed for ${input.partID}: ${String(error)}`),
      }).pipe(
        Effect.catchCause((cause) => {
          log.error("mark timed out failed", { partID: input.partID, cause: String(cause) })
          return Effect.succeed(undefined)
        }),
      )
      if (!result) return false

      const sessionID = result.row.session_id as SessionID
      const interrupted = ToolExecution.interrupt(sessionID, result.updateData.callID)

      if (Database.dialect !== "pg") yield* publishTimedOut(events, result, now)

      if (COMMAND_TOOLS.has(result.updateData.tool)) {
        yield* Option.match(maybeSandbox, {
          onNone: () => Effect.void,
          onSome: (provider) =>
            provider.interrupt(sessionID).pipe(
              Effect.timeout("10 seconds"),
              Effect.catchCause((cause) => {
                log.warn("sandbox interrupt on timeout failed", { partID: input.partID, cause: String(cause) })
                return Effect.void
              }),
            ),
        })
      }

      log.warn("marked tool as timed out", {
        partID: result.row.id,
        sessionID,
        tool: result.updateData.tool,
        runningMs: now - input.expectedStart,
        interrupted,
      })
      return true
    })

    return Service.of({ markTimedOut })
  }),
)

const COMMAND_TOOLS = new Set(["bash", "task"])
const RETRY_WITH_VERIFICATION = new Set(["write", "edit", "apply_patch"])
const MAX_AGENT_RETRY_ATTEMPTS = 2

function publishTimedOut(
  events: EventV2Bridge.Service["Service"],
  result: { row: ToolPartRow; updateData: StoredToolPart },
  now: number,
) {
  const sessionID = result.row.session_id as SessionID
  return events.publish(SessionV1.Event.PartUpdated, {
    sessionID,
    part: {
      ...result.updateData,
      id: result.row.id,
      sessionID,
      messageID: result.row.message_id,
    },
    time: now,
  })
}

export const defaultLayer = layer

export function transitionRunningTool(part: ToolPart, expectedStart: number) {
  const { id, sessionID: _, messageID: __, ...data } = part
  return Effect.tryPromise({
    try: () =>
      Database.transaction(
        async (tx: LifecycleDb) => {
          const updated = await tx
            .update(PartTable)
            .set({ data, time_updated: Date.now() })
            .where(runningToolCasCondition(id, expectedStart))
            .returning({ id: PartTable.id })
            .all()
          return updated.length > 0
        },
        { behavior: "immediate" },
      ),
    catch: (error) => new Error(`tool transition failed for ${part.id}: ${String(error)}`),
  }).pipe(
    Effect.tapError((error) => Effect.sync(() => log.error("tool transition failed", { partID: part.id, error: String(error) }))),
    Effect.orDie,
  )
}

function parseToolPart(data: unknown): StoredRunningToolPart | undefined {
  const value = typeof data === "string" ? parseJson(data) : data
  if (!isRecord(value)) return
  if (value.type !== "tool") return
  if (typeof value.callID !== "string") return
  if (typeof value.tool !== "string") return
  if (!isRecord(value.state)) return
  if (value.state.status !== "running") return
  if (!isRecord(value.state.time)) return
  if (typeof value.state.time.start !== "number") return
  return value as StoredRunningToolPart
}

function isWatchdogTimeout(data: unknown) {
  const value = typeof data === "string" ? parseJson(data) : data
  if (!isRecord(value) || !isRecord(value.state) || !isRecord(value.state.metadata)) return false
  return value.state.metadata.timeout === true
}

function parseJson(data: string): unknown {
  try {
    return JSON.parse(data)
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function runningToolCasCondition(partID: PartID, start: number) {
  if (Database.dialect === "pg") {
    return and(
      eq(PartTable.id, partID),
      sql`${PartTable.data}->>'type' = 'tool'`,
      sql`${PartTable.data}->'state'->>'status' = 'running'`,
      sql`(${PartTable.data}->'state'->'time'->>'start')::bigint = ${start}`,
    )
  }
  return and(
    eq(PartTable.id, partID),
    sql`json_extract(${PartTable.data}, '$.type') = 'tool'`,
    sql`json_extract(${PartTable.data}, '$.state.status') = 'running'`,
    sql`json_extract(${PartTable.data}, '$.state.time.start') = ${start}`,
  )
}

export * as SessionTools from "./mark-timed-out"
