import { Cause, Effect } from "effect"

/** Recover each iteration, so a failed query does not stop future scans. */
export const recoverIteration = <A, E, R>(name: string, iteration: Effect.Effect<A, E, R>) =>
  iteration.pipe(
    Effect.asVoid,
    Effect.catchCause((cause) => Cause.hasInterrupts(cause) ? Effect.interrupt
      : Effect.logWarning(`${name} failed; next iteration will retry`, { cause })),
  )
