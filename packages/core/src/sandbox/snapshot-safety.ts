import { Duration, Effect } from "effect"

/** OpenSandbox TTL is an absolute deadline; command traffic does not renew it. */
export const ensureSandboxLifetime = (
  sandbox: { getInfo(): Promise<{ expiresAt: Date | null }>; renew(seconds: number): Promise<unknown> },
  ttlSeconds: number,
  minimumRemainingSeconds = Math.max(60, ttlSeconds / 3),
) => Effect.tryPromise({
  try: async () => {
    const info = await sandbox.getInfo()
    if (info.expiresAt && info.expiresAt.getTime() - Date.now() < minimumRemainingSeconds * 1000)
      await sandbox.renew(Math.max(ttlSeconds, minimumRemainingSeconds + 60))
  },
  catch: (cause) => new Error("Sandbox lifetime renewal failed; source retained", { cause }),
})

/** Fail closed: losing the lease stops the work, not just its heartbeat. */
export const withSnapshotLease = <A, E, R>(
  renew: Effect.Effect<boolean, Error>,
  work: Effect.Effect<A, E, R>,
  interval = Duration.seconds(60),
) =>
  Effect.gen(function* () {
    if (!(yield* renew)) return yield* Effect.fail(new Error("Snapshot operation lease lost"))
    return yield* Effect.raceFirst(
      work,
      Effect.forever(
        Effect.gen(function* () {
          yield* Effect.sleep(interval)
          if (!(yield* renew)) return yield* Effect.fail(new Error("Snapshot operation lease lost"))
        }),
      ),
    )
  })

/** A failed health check is not evidence that a sandbox has disappeared. */
export const reconnectSandbox = <A>(
  connect: Effect.Effect<A, Error>,
  gone: (error: Error) => boolean,
  retryDelay = Duration.seconds(5),
) =>
  Effect.gen(function* () {
    let last = new Error("Sandbox temporarily unavailable; source retained")
    for (let round = 0; round < 3; round++) {
      const result = yield* connect.pipe(Effect.result)
      if (result._tag === "Success") return result.success
      if (gone(result.failure)) return null
      last = result.failure
      if (round < 2) yield* Effect.sleep(retryDelay)
    }
    return yield* Effect.fail(last)
  })
