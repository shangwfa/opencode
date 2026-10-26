import { expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Ref } from "effect"
import { claimCommandSession, commandSessionKey } from "../src/sandbox/opensandbox/command-session"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

it.effect("a cache hit inside the claim settles the token", () =>
  Effect.gen(function* () {
    const claims = yield* Ref.make(new Map<string, Deferred.Deferred<string, Error>>())
    const id = yield* claimCommandSession(
      claims,
      commandSessionKey("session", "source"),
      Effect.succeed("already-created"),
    )
    expect(id).toBe("already-created")
  }),
)

it.effect("same-generation waiters share a claim, replacement generations do not", () =>
  Effect.gen(function* () {
    const claims = yield* Ref.make(new Map<string, Deferred.Deferred<string, Error>>())
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<string>()
    const key = commandSessionKey("session", "source")
    const first = yield* claimCommandSession(
      claims,
      key,
      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
    ).pipe(Effect.forkChild)
    yield* Deferred.await(entered)
    const waiter = yield* claimCommandSession(claims, key, Effect.die("duplicate create")).pipe(Effect.forkChild)
    yield* Effect.yieldNow
    expect(yield* claimCommandSession(claims, commandSessionKey("session", "replacement"), Effect.succeed("new"))).toBe(
      "new",
    )
    yield* Deferred.succeed(release, "old")
    expect(yield* Fiber.join(first)).toBe("old")
    expect(yield* Fiber.join(waiter)).toBe("old")
  }),
)

for (const defect of [false, true]) {
  it.effect(`claim failure propagates${defect ? " defects" : " errors"} and allows retry`, () =>
    Effect.gen(function* () {
      const claims = yield* Ref.make(new Map<string, Deferred.Deferred<string, Error>>())
      const key = commandSessionKey("session", "source")
      const error = new Error("create failed")
      expect(
        (yield* claimCommandSession(claims, key, defect ? Effect.die(error) : Effect.fail(error)).pipe(Effect.exit))
          ._tag,
      ).toBe("Failure")
      yield* Effect.yieldNow
      expect(yield* claimCommandSession(claims, key, Effect.succeed("retry"))).toBe("retry")
    }),
  )
}

it.effect("a late invalidated creator cannot erase a replacement claim", () =>
  Effect.gen(function* () {
    const claims = yield* Ref.make(new Map<string, Deferred.Deferred<string, Error>>())
    const key = commandSessionKey("session", "source")
    const oldReady = yield* Deferred.make<void>()
    const oldRelease = yield* Deferred.make<string>()
    const old = yield* claimCommandSession(
      claims,
      key,
      Deferred.succeed(oldReady, undefined).pipe(Effect.andThen(Deferred.await(oldRelease))),
    ).pipe(Effect.forkChild)
    yield* Deferred.await(oldReady)
    const token = (yield* Ref.get(claims)).get(key)
    if (!token) return yield* Effect.die(new Error("missing old claim"))
    yield* Ref.update(claims, (map) => {
      map.delete(key)
      return map
    })
    yield* Deferred.fail(token, new Error("invalidated"))
    expect((yield* Fiber.await(old))._tag).toBe("Failure")
    const newReady = yield* Deferred.make<void>()
    const newRelease = yield* Deferred.make<string>()
    const replacement = yield* claimCommandSession(
      claims,
      key,
      Deferred.succeed(newReady, undefined).pipe(Effect.andThen(Deferred.await(newRelease))),
    ).pipe(Effect.forkChild)
    yield* Deferred.await(newReady)
    const newToken = (yield* Ref.get(claims)).get(key)
    yield* Deferred.succeed(oldRelease, "late-old")
    yield* Effect.yieldNow
    expect((yield* Ref.get(claims)).get(key)).toBe(newToken)
    yield* Deferred.succeed(newRelease, "new")
    expect(yield* Fiber.join(replacement)).toBe("new")
  }),
)
