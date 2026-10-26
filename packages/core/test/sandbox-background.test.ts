import { expect } from "bun:test"
import { Cause, Effect } from "effect"
import { recoverIteration } from "../src/sandbox/opensandbox/background"
import { testEffect } from "./lib/effect"
import { Layer } from "effect"

const it = testEffect(Layer.empty)
it.effect("background recovery preserves shutdown interruption", () => Effect.gen(function* () {
  const exit = yield* recoverIteration("test shutdown", Effect.interrupt).pipe(Effect.exit)
  expect(exit._tag).toBe("Failure")
  if (exit._tag === "Failure") expect(Cause.hasInterrupts(exit.cause)).toBe(true)
}))
for (const failure of ["typed", "defect"] as const) {
  it.effect(`a ${failure} failure does not prevent the next background scan`, () =>
    Effect.gen(function* () {
      let scans = 0
      const scan = Effect.suspend(() => {
        scans++
        if (scans === 1) return failure === "typed" ? Effect.fail(new Error("PG unavailable")) : Effect.die(new Error("PG defect"))
        return Effect.void
      })
      yield* recoverIteration("test scan", scan)
      yield* recoverIteration("test scan", scan)
      expect(scans).toBe(2)
    }),
  )
}
