import { Effect, Option } from "effect"
import { Database } from "../database/database.js"
import { ExecLogTable, type NewExecLog } from "./sql.js"

/**
 * Audit sink for command execution and permission denials (v1's exec_log).
 * Persistence is optional and never fails the caller: an audit write must not
 * break the deny path or the tool call it records.
 */
export const insert = (row: NewExecLog): Effect.Effect<void> =>
  Effect.serviceOption(Database.Service).pipe(
    Effect.flatMap((option) => (Option.isNone(option) ? Effect.void : option.value.db.insert(ExecLogTable).values(row).run())),
    Effect.asVoid,
    Effect.catchCause((cause) => Effect.logWarning("exec log insert failed", cause)),
  )

/** Records a permission denial (v1's recordDenial): denied status, matched rule, and ask payload. */
export const recordDenial = (input: {
  readonly sessionID: string
  readonly permission: string
  readonly patterns: ReadonlyArray<string>
  readonly tool?: { readonly messageID: string; readonly callID: string } | null
  readonly metadata?: Record<string, unknown> | null
  readonly rule: string
}): Effect.Effect<void> => {
  const now = Date.now()
  return insert({
    id: `deny-${now}-${crypto.randomUUID().slice(0, 8)}`,
    session_id: input.sessionID as NewExecLog["session_id"],
    command: JSON.stringify({
      permission: input.permission,
      patterns: input.patterns,
      tool: input.tool ?? null,
      metadata: input.metadata ?? null,
    }),
    status: "denied",
    rule: input.rule,
    source: "permission-deny",
    time_started: now,
    time_finished: now,
  })
}
