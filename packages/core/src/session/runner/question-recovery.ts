export * as QuestionRecovery from "./question-recovery.js"

import { Effect, Schema } from "effect"
import type { Bus } from "../../bus.js"
import type { Database } from "../../database/database.js"
import { Form } from "../../form.js"
import { Permission } from "../../permission.js"
import { HitlLedger } from "../../hitl/ledger.js"
import { SessionEvent } from "../event.js"
import { SessionSchema } from "../schema.js"
import type { SessionMessage } from "../message.js"
import { QuestionTool } from "../../tool/plugin/question.js"

/** A running tool part recovered from a dead process. */
export interface StaleTool {
  readonly assistantMessageID: SessionMessage.ID
  readonly id: string
  readonly name: string
  /** Running parts carry the decoded input object (streaming parts carry text and are not recoverable). */
  readonly input: Readonly<Record<string, unknown>>
  readonly executed: boolean
}

export interface Deps {
  readonly bus: Bus.Interface
  readonly forms: Form.Interface
  readonly permissions: Permission.Interface
  readonly database: Database.Interface
}

/**
 * Recovery barrier for interrupted HITL tools on PostgreSQL SaaS.
 *
 * A tool blocked on a Form/Permission request when the process died leaves a
 * running tool part plus a pending row in the durable HITL ledger. Instead of
 * failing the part and re-asking (the pre-recovery behavior), the new
 * execution owner revives the original request and blocks until the user
 * answers — on any pod — then records the canonical terminal event so the
 * resumed model turn continues from the answer.
 *
 * Permission recovery never replays the approved operation: the original
 * execution context is gone, so an approval is recorded as an explicit
 * not-executed failure and the model re-issues the call if still needed (a
 * persisted `always` approval re-authorizes it without a new prompt). This is
 * the deliberate first-phase boundary of the design document: the user's
 * decision is preserved, side effects are never duplicated blindly.
 */

export interface Deps {
  readonly bus: Bus.Interface
  readonly forms: Form.Interface
  readonly database: Database.Interface
}

const APPROVED_NOT_EXECUTED =
  "The user approved this request, but the operation was not executed because the server restarted. The approval is recorded; re-issue the operation if it is still needed."

const REJECTED_NOT_EXECUTED = "The user rejected this request while the server restarted"

/** Settles a running tool part against its durable HITL requests. */
export const settleTool = Effect.fn("QuestionRecovery.settleTool")(function* (
  deps: Deps,
  sessionID: SessionSchema.ID,
  tool: StaleTool,
) {
  if (deps.database.dialect !== "postgres") return false
  const ledger = HitlLedger.make(deps.database.db)
  const rows = yield* ledger.pending(sessionID).pipe(Effect.orDie)

  // Permission first: the live executor asserts before it asks anything else,
  // so a recovered question replays the same ordering. An approved non-question
  // operation is never replayed: its execution context died with the process,
  // and first-phase recovery ships no per-tool replay adapters.
  const permissionRow = rows.find(
    (row) => row.kind === "permission" && (row.payload as Permission.Request).source?.id === tool.id,
  )
  if (permissionRow) {
    const decision = yield* deps.permissions.awaitSettled(permissionRow.id as Permission.ID)
    if (decision.reply === "reject") {
      yield* deps.bus.publish(SessionEvent.Tool.Failed, {
        sessionID,
        assistantMessageID: tool.assistantMessageID,
        id: tool.id,
        error: { type: "permission.rejected", message: decision.message ?? REJECTED_NOT_EXECUTED },
        executed: tool.executed,
      })
      return true
    }
    if (tool.name !== QuestionTool.name) {
      yield* deps.bus.publish(SessionEvent.Tool.Failed, {
        sessionID,
        assistantMessageID: tool.assistantMessageID,
        id: tool.id,
        error: { type: "aborted", message: APPROVED_NOT_EXECUTED },
        executed: tool.executed,
      })
      return true
    }
    // An approved question continues to its form, mirroring the live executor.
  }

  const formRow = rows.find((row) => {
    if (row.kind !== "form") return false
    const metadata = (row.payload as Form.Info).metadata
    const link = typeof metadata?.["tool"] === "object" ? (metadata["tool"] as Record<string, unknown>) : undefined
    return link?.["id"] === tool.id
  })
  if (formRow && tool.name === QuestionTool.name) {
    const input = yield* Schema.decodeUnknownEffect(QuestionTool.Input)(tool.input).pipe(Effect.orDie)
    const state = yield* deps.forms.awaitSettled(formRow.id as Form.ID)
    if (state.status === "cancelled") {
      yield* deps.bus.publish(SessionEvent.Tool.Failed, {
        sessionID,
        assistantMessageID: tool.assistantMessageID,
        id: tool.id,
        error: { type: "aborted", message: "The user dismissed this question" },
        executed: tool.executed,
      })
      return true
    }
    const result = QuestionTool.answeredResult(input.questions, state.answer)
    const text = result.content[0]
    if (text === undefined) return yield* Effect.die(new Error(`Question recovery has no content: ${tool.id}`))
    yield* deps.bus.publish(SessionEvent.Tool.Success, {
      sessionID,
      assistantMessageID: tool.assistantMessageID,
      id: tool.id,
      content: [{ type: "text" as const, text }],
      metadata: result.metadata,
      executed: tool.executed,
    })
    return true
  }

  // A non-question tool with only an approval link: the decision is preserved
  // (handled above); without a form the part has nothing left to wait for.
  return permissionRow !== undefined
})
