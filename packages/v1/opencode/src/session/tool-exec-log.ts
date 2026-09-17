/**
 * Persist one exec_log row per LLM tool call so the exec trail covers the
 * non-bash tool path (bash/proxy execs have their own `exec`/`exec-async`
 * sources). The SaaS message pipeline (session/processor.ts) publishes a V1
 * `message.part.updated` event for every tool-part state transition
 * (pending → running → completed/error).
 *
 * Correctness rules learned from the ses_f70e676f1ffe review:
 * - The row is keyed by partID, not callID: providers only guarantee call ID
 *   uniqueness within one response, so callID reuse across sessions (or the
 *   native runtime's tool-name fallback) must never alias two calls.
 * - Every event is an upsert scoped to the row's own session and status: a
 *   late or replayed terminal event cannot flip a settled row, and a terminal
 *   event whose earlier insert failed still recovers the audit trail.
 * - Writes run on a bounded background queue; `events.publish` never waits on
 *   PG. Under overload the newest events are dropped (warn-logged) — audit is
 *   best-effort and must not stall the LLM stream.
 *
 * A call that hangs before execution — e.g. the provider stream drops the
 * argument deltas after tool-input-start — shows up as `running` with no
 * `time_finished` (see docs/guides/session-stuck-analysis-20260911.md).
 */
import { and, eq } from "drizzle-orm"
import { Cause, Effect, Layer, Queue } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import * as Log from "@opencode-ai/core/util/log"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "../storage/db"
import { ExecLogTable, type ExecLogSource } from "./exec-log.pg"
import type { SessionID } from "./schema"

const log = Log.create({ service: "tool-exec-log" })

const TOOL_LOG_ID_PREFIX = "tool-"
const MAX_TOOL_INPUT_LOG = 8192
const PART_UPDATED_TYPE = "message.part.updated"
const QUEUE_CAPACITY = 1024

type V1ToolPartState = {
  status: "pending" | "running" | "completed" | "error"
  input?: Record<string, unknown>
  error?: string
  title?: string
  time?: { start?: number; end?: number }
}

type V1ToolPart = {
  id: string
  sessionID: SessionID
  messageID: string
  type: "tool"
  tool: string
  callID: string
  state: V1ToolPartState
}

const epoch = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : Date.now())

// Keep `command` single-encoded JSON: intact inputs embed as an object,
// oversized ones degrade to a marked truncated string.
const toolInput = (input: unknown) => {
  let text: string
  try {
    text = JSON.stringify(input ?? {}) ?? "{}"
  } catch {
    text = String(input)
  }
  if (text.length <= MAX_TOOL_INPUT_LOG) return input ?? {}
  return { truncated: text.slice(0, MAX_TOOL_INPUT_LOG) + "...[truncated]" }
}

const persist = (part: V1ToolPart, time: number) =>
  Effect.tryPromise(() => {
    const id = `${TOOL_LOG_ID_PREFIX}${part.id}`
    // Guards keep updates inside the owning session and only while the row is
    // still `running` — terminal rows are settled and immutable.
    const owned = and(eq(ExecLogTable.id, id), eq(ExecLogTable.session_id, part.sessionID))
    const running = and(owned, eq(ExecLogTable.status, "running"))
    const timeStarted = epoch(part.state.time?.start ?? time)
    const command = (withInput: boolean) =>
      JSON.stringify({
        tool: part.tool,
        callID: part.callID,
        partID: part.id,
        assistantMessageID: part.messageID,
        ...(withInput ? { input: toolInput(part.state.input) } : {}),
      })
    return Database.use((db) => {
      switch (part.state.status) {
        case "pending":
          return db
            .insert(ExecLogTable)
            .values({
              id,
              session_id: part.sessionID,
              command: command(false),
              status: "running" as const,
              source: "tool-call" as ExecLogSource,
              time_started: timeStarted,
              time_created: time,
              time_updated: time,
            })
            .onConflictDoNothing()
        case "running":
          return db
            .insert(ExecLogTable)
            .values({
              id,
              session_id: part.sessionID,
              command: command(true),
              status: "running" as const,
              source: "tool-call" as ExecLogSource,
              time_started: timeStarted,
              time_created: time,
              time_updated: time,
            })
            .onConflictDoUpdate({
              target: ExecLogTable.id,
              set: { command: command(true), time_updated: time },
              setWhere: running,
            })
        case "completed": {
          const timeFinished = epoch(part.state.time?.end ?? time)
          return db
            .insert(ExecLogTable)
            .values({
              id,
              session_id: part.sessionID,
              command: command(false),
              status: "completed" as const,
              source: "tool-call" as ExecLogSource,
              time_started: timeStarted,
              time_finished: timeFinished,
              time_created: time,
              time_updated: time,
            })
            .onConflictDoUpdate({
              target: ExecLogTable.id,
              set: { status: "completed" as const, time_finished: timeFinished, time_updated: time },
              setWhere: running,
            })
        }
        case "error": {
          const timeFinished = epoch(part.state.time?.end ?? time)
          return db
            .insert(ExecLogTable)
            .values({
              id,
              session_id: part.sessionID,
              command: command(false),
              status: "failed" as const,
              error: part.state.error ?? "unknown tool error",
              source: "tool-call" as ExecLogSource,
              time_started: timeStarted,
              time_finished: timeFinished,
              time_created: time,
              time_updated: time,
            })
            .onConflictDoUpdate({
              target: ExecLogTable.id,
              set: {
                status: "failed" as const,
                error: part.state.error ?? "unknown tool error",
                time_finished: timeFinished,
                time_updated: time,
              },
              setWhere: running,
            })
        }
      }
    })
  }).pipe(
    Effect.catch((error) => Effect.sync(() => log.error("failed to persist tool exec log", { error }))),
    Effect.asVoid,
  )

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const queue = yield* Queue.dropping<{ part: V1ToolPart; time: number }>(QUEUE_CAPACITY)

    const unsubscribe = yield* events.listen((event) => {
      if (event.type !== PART_UPDATED_TYPE) return Effect.void
      const part = (event.data as { part?: V1ToolPart }).part
      if (!part || part.type !== "tool" || !part.callID || !part.sessionID) return Effect.void
      const time = epoch((event.data as { time?: unknown }).time)
      return Queue.offer(queue, { part, time }).pipe(
        Effect.flatMap((offered) =>
          offered ? Effect.void : Effect.sync(() => log.warn("tool exec log queue full, dropping event", { callID: part.callID })),
        ),
      )
    })

    // Single consumer: preserves per-call event order and keeps write
    // amplification at one connection regardless of event storms. The queue
    // ends with a Done failure on shutdown; interrupts must still pass
    // through or layer disposal hangs waiting for this fiber.
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        while (true) {
          const item = yield* Queue.take(queue)
          yield* persist(item.part, item.time)
        }
      }).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterrupts(cause),
          () => Effect.void,
        ),
      ),
    )

    yield* Effect.addFinalizer(() =>
      unsubscribe.pipe(Effect.andThen(Queue.shutdown(queue).pipe(Effect.ignore, Effect.asVoid))),
    )
  }),
)

export const node = LayerNode.make({ name: "session/tool-exec-log", layer, deps: [EventV2Bridge.node] })

export * as ToolExecLog from "./tool-exec-log"
