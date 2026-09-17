import { Effect, Exit } from "effect"
import { HttpApiError } from "effect/unstable/httpapi"
import { Flag } from "@/flag/flag"
import { SessionID } from "@/session/schema"

const locks = new Map<SessionID, number>()

export function withSessionLock<A, E, R>(sessionID: SessionID, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  return Effect.gen(function* () {
    locks.set(sessionID, (locks.get(sessionID) ?? 0) + 1)
    const exit = yield* Effect.exit(effect)
    const count = (locks.get(sessionID) ?? 1) - 1
    if (count <= 0) locks.delete(sessionID)
    else locks.set(sessionID, count)
    if (Exit.isFailure(exit)) yield* Effect.failCause(exit.cause)
    return (exit as any).value
  })
}

export function waitForSessionLock(
  sessionID: SessionID,
  timeoutSec: number = Flag.OPENCODE_SESSION_LOCK_TIMEOUT_SEC ?? 60,
): Effect.Effect<void, HttpApiError.ServiceUnavailable> {
  return Effect.gen(function* () {
    const deadline = Date.now() + timeoutSec * 1000
    while ((locks.get(sessionID) ?? 0) > 0) {
      if (Date.now() >= deadline) {
        yield* Effect.logError("waitForSessionLock timed out", { sessionID, heldSec: timeoutSec })
        return yield* new HttpApiError.ServiceUnavailable({})
      }
      yield* Effect.sleep("50 millis")
    }
  })
}

export function _getLockCount(sessionID: SessionID): number {
  return locks.get(sessionID) ?? 0
}

export function _clearLocks(): void {
  locks.clear()
}
