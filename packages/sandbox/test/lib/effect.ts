import { test, type TestOptions } from "bun:test"
import { Effect, Layer, type Scope } from "effect"
import { TestConsole } from "effect/testing"

type Body<A, E, R> = Effect.Effect<A, E, R | Scope.Scope> | (() => Effect.Effect<A, E, R | Scope.Scope>)

const run = <A, E, R, E2>(value: Body<A, E, R>, layer: Layer.Layer<R, E2>) =>
  Effect.runPromise(
    (typeof value === "function" ? value() : value).pipe(
      Effect.scoped,
      Effect.provide(layer as Layer.Layer<R>),
      Effect.provide(TestConsole.layer),
    ),
  )

/**
 * Live-clock test harness mirroring @opencode/core's test/lib/effect shape for
 * real-backend integration tests (docker daemon, OpenSandbox server).
 */
export const testEffect = <R, E>(layer: Layer.Layer<R, E>) => {
  const live = <A, E2>(name: string, value: Body<A, E2, R>, opts?: number | TestOptions) =>
    test(name, () => run(value, layer), opts)
  live.skip = <A, E2>(name: string, value: Body<A, E2, R>, opts?: number | TestOptions) =>
    test.skip(name, () => run(value, layer), opts)
  return { live }
}
