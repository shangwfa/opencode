import { Context, Effect, Layer, Option } from "effect"
import { type ToolPart, type ToolStateRunning } from "@opencode-ai/core/v1/session"
import { PartID, type SessionID } from "./schema"
import * as Log from "@opencode-ai/core/util/log"
import { SandboxProvider } from "@/tool/sandbox-provider"
import { Database } from "../storage/db"
import { PartTable } from "./session.pg"
import { and, eq, sql } from "drizzle-orm"

const log = Log.create({ service: "session.tools" })

type StoredToolPart = Omit<ToolPart, "id" | "sessionID" | "messageID">
type StoredRunningToolPart = Omit<StoredToolPart, "state"> & { state: ToolStateRunning }
type ToolPartRow = Pick<typeof PartTable.$inferSelect, "id" | "session_id" | "message_id" | "data">
type LifecycleDb = {
  select(): {
    from(table: typeof PartTable): {
      where(condition: ReturnType<typeof eq>): {
        get(): Promise<ToolPartRow | undefined>
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

    const markTimedOut: Interface["markTimedOut"] = Effect.fn("SessionTools.markTimedOut")(function* (input) {
      const now = input.now ?? Date.now()
      const result = yield* Effect.tryPromise({
        try: () =>
          Database.transaction(
            async (tx: LifecycleDb) => {
              const row = await tx.select().from(PartTable).where(eq(PartTable.id, input.partID)).get()
              const part = parseToolPart(row?.data)
              if (!row || !part) return undefined
              if (part.state.time.start !== input.expectedStart) return undefined
              if (now - part.state.time.start <= input.timeoutMs) return undefined

              const updateData: StoredToolPart = {
                ...part,
                state: {
                  status: "error",
                  input: part.state.input,
                  error: `Tool execution timed out after ${Math.round(input.timeoutMs / 1000)}s (watchdog)`,
                  metadata: { ...(part.state.metadata ?? {}), timeout: true },
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
              return { row, updateData }
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

      if (COMMAND_TOOLS.has(result.updateData.tool)) {
        yield* Option.match(maybeSandbox, {
          onNone: () => Effect.void,
          onSome: (provider) =>
            provider.interrupt(sessionID).pipe(
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
      })
      return true
    })

    return Service.of({ markTimedOut })
  }),
)

const COMMAND_TOOLS = new Set(["bash", "task"])

export const defaultLayer = layer

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
