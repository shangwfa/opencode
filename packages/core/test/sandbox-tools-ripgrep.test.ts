import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer, Option } from "effect"
import type { Tool } from "@opencode/schema/tool"
import { ensureRipgrep, type Deps } from "@opencode/core/sandbox/tools"
import { testEffect } from "./lib/effect"

const location = { directory: "/workspace" } as const

const makeDeps = (result: { exitCode: number | null; output: string }) => {
  let runs = 0
  const deps = {
    provider: {
      enabled: true,
      run: () =>
        Effect.sync(() => {
          runs++
          return { ...result, timedOut: false }
        }),
    },
    location,
    permission: {},
  } as unknown as Deps
  return { deps, runs: () => runs }
}

const context = (sessionID: string) => ({ sessionID }) as unknown as Tool.Context

const it = testEffect(Layer.empty)

describe("ensureRipgrep", () => {
  it.effect("passes and caches when the probe finds rg", () =>
    Effect.gen(function* () {
      const sid = `ses_test_rg_ok_${Date.now()}`
      const { deps, runs } = makeDeps({ exitCode: 0, output: "/usr/bin/rg\n" })
      yield* ensureRipgrep(deps, context(sid))
      yield* ensureRipgrep(deps, context(sid))
      // The second call is served from cache: one probe per session.
      expect(runs()).toBe(1)
    }),
  )

  it.effect("fails with an explicit message when rg is missing", () =>
    Effect.gen(function* () {
      const sid = `ses_test_rg_missing_${Date.now()}`
      const { deps, runs } = makeDeps({ exitCode: 127, output: "" })
      const exit = yield* Effect.exit(ensureRipgrep(deps, context(sid)))
      expect(Exit.isFailure(exit)).toBe(true)
      const reason = Option.getOrThrow(Exit.getCause(exit)).reasons[0]
      if (Cause.isFailReason(reason))
        expect(String((reason.error as { message?: string }).message)).toContain("ripgrep (rg) is not available")
      // Cached miss keeps failing without re-probing.
      const again = yield* Effect.exit(ensureRipgrep(deps, context(sid)))
      expect(Exit.isFailure(again)).toBe(true)
      expect(runs()).toBe(1)
    }),
  )

  it.effect("treats a zero exit with empty output as missing", () =>
    Effect.gen(function* () {
      const sid = `ses_test_rg_empty_${Date.now()}`
      const { deps } = makeDeps({ exitCode: 0, output: "" })
      const exit = yield* Effect.exit(ensureRipgrep(deps, context(sid)))
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )
})
