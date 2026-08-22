import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { withQueryTimeout } from "../../src/storage/db-core-bridge"

function pretty(exit: Exit.Exit<unknown, unknown>) {
  return Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""
}

describe("withQueryTimeout (PG client-side query timeout)", () => {
  test("resolves normally when query finishes within timeout", async () => {
    const exit = await Effect.runPromiseExit(
      withQueryTimeout(Effect.succeed("fast")),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  test("fails with clear error when query hangs past timeout", async () => {
    const exit = await Effect.runPromiseExit(
      withQueryTimeout(
        Effect.promise(() => new Promise((resolve) => setTimeout(() => resolve("late"), 5000))),
        100,
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(pretty(exit)).toContain("PG query timed out")
  })
})
