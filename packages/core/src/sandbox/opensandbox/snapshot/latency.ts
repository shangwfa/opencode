import { Clock, Effect, Exit } from "effect"

export type SnapshotStage =
  | "connect"
  | "content_check"
  | "lifetime"
  | "manifest"
  | "session_lock"
  | "create_request"
  | "settle"
  | "destroy"
  | "command_create"
  | "command_run"
  | "command_delete"

export type SnapshotTimingContext = {
  readonly sessionID?: string
  readonly sandboxID?: string
  readonly snapshotID?: string
  readonly operationID?: string
  readonly kind?: "snapshot_destroy" | "snapshot_refresh"
  readonly phase?: "content_check" | "manifest" | "probe"
}

export const logSnapshotStage = (context: SnapshotTimingContext, stage: SnapshotStage, ms: number, outcome: "success" | "failure") =>
  Effect.logInfo("snapshot stage", { ...context, stage, ms: Math.max(0, ms), outcome })

/** Logs timing only: preserve the work's value, typed error, defect and interruption. */
export const measureSnapshotStage = <A, E, R>(
  context: SnapshotTimingContext,
  stage: SnapshotStage,
  work: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => Effect.gen(function* () {
  const startedAt = yield* Clock.currentTimeMillis
  return yield* work.pipe(Effect.onExit((exit) => Effect.gen(function* () {
    const finishedAt = yield* Clock.currentTimeMillis
    yield* logSnapshotStage(context, stage, finishedAt - startedAt, Exit.isSuccess(exit) ? "success" : "failure")
  })))
})
