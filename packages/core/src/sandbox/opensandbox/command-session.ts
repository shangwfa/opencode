import { Deferred, Effect, Ref } from "effect"

export const commandSessionKey = (sessionID: string, sandboxID: string) => JSON.stringify([sessionID, sandboxID])

/** Every successful branch settles its generation-scoped token, including cache hits. */
export const claimCommandSession = <R>(
  claims: Ref.Ref<Map<string, Deferred.Deferred<string, Error>>>,
  key: string,
  create: Effect.Effect<string, Error, R>,
) =>
  Effect.gen(function* () {
    const token = yield* Deferred.make<string, Error>()
    const winner = yield* Ref.modify(claims, (map) => {
      const existing = map.get(key)
      if (existing) return [existing, map] as const
      return [token, map.set(key, token)] as const
    })
    if (winner !== token) return yield* Deferred.await(winner)
    const creation = create.pipe(
      Effect.tap((id) => Deferred.succeed(token, id)),
      Effect.catchCause((cause) => Deferred.failCause(token, cause)),
      Effect.ensuring(
        Effect.gen(function* () {
          const removed = yield* Ref.modify(claims, (map) => {
            if (map.get(key) !== token) return [false, map] as const
            map.delete(key)
            return [true, map] as const
          })
          if (removed) yield* Deferred.fail(token, new Error(`Command session creation interrupted: ${key}`))
        }),
      ),
    )
    yield* Effect.forkDetach(creation)
    return yield* Deferred.await(token)
  })
