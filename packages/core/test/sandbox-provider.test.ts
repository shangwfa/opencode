import { describe, expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Semaphore } from "effect"
import { SandboxProvider, assembleStreamText, isCommandSessionGone, isSandboxGone, rootSessionID, withOperationTimeout, withSemaphoreWaitTimeout } from "@opencode/core/sandbox/provider"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Database } from "@opencode/core/database/database"
import { Global } from "@opencode/util/global"
import { filesystem } from "@opencode/util/effect/app-node-platform"
import { FSUtil } from "@opencode/util/fs-util"
import { testEffect } from "./lib/effect"

// Without OPENCODE_SANDBOX_ENABLED the provider layer builds in disabled mode:
// tools keep their local path and lifecycle helpers stay safe no-ops.
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, FSUtil.node, filesystem, Global.node, SandboxProvider.node])),
)

describe("assembleStreamText", () => {
  // execd emits one stream event per output line with the newline stripped.
  test("restores line structure from per-line events", () => {
    expect(assembleStreamText(["/workspace/a.ts", "/workspace/b.ts", "/workspace/c.ts"])).toBe(
      "/workspace/a.ts\n/workspace/b.ts\n/workspace/c.ts",
    )
  })

  test("keeps a single line without a trailing newline", () => {
    expect(assembleStreamText(["done"])).toBe("done")
    expect(assembleStreamText(["1"])).toBe("1")
  })

  test("returns empty output for no events", () => {
    expect(assembleStreamText([])).toBe("")
  })

  test("never fuses lines into one string", () => {
    const fused = assembleStreamText(["line1", "line2"])
    expect(fused).toContain("\n")
    expect(fused.split("\n")).toEqual(["line1", "line2"])
  })

  test("round-trips through the line-oriented glob parser shape", () => {
    const lines = assembleStreamText(["f1.txt", "f2.txt", "f3.txt"]).split("\n").filter((line) => line.length > 0)
    expect(lines).toEqual(["f1.txt", "f2.txt", "f3.txt"])
  })
})

describe("SandboxProvider disabled layer", () => {
  it.effect("reports disabled and keeps lifecycle as no-ops", () =>
    Effect.gen(function* () {
      const provider = yield* SandboxProvider.Service
      expect(provider.enabled).toBe(false)
      yield* provider.interrupt("ses_anything")
      yield* provider.destroy("ses_anything")
    }),
  )

  it.effect("refuses remote runs with a defect instead of silently executing locally", () =>
    Effect.gen(function* () {
      const provider = yield* SandboxProvider.Service
      const exit = yield* provider
        .run({ sessionID: "ses_x", command: "echo hi", hostWorkdir: "/workspace", timeoutMs: 1000 })
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )
})

describe("rootSessionID", () => {
  const chain = (parents: Record<string, string | null>) => {
    const seen: string[] = []
    const lookup = (id: string) =>
      Effect.gen(function* () {
        seen.push(id)
        return { parentID: parents[id] ?? null }
      })
    return { lookup, seen }
  }

  it.effect("returns the session itself when it has no parent", () =>
    Effect.gen(function* () {
      const { lookup } = chain({})
      expect(yield* rootSessionID("ses_root", lookup)).toBe("ses_root")
    }),
  )

  it.effect("resolves a subagent child chain to the root session", () =>
    Effect.gen(function* () {
      const { lookup, seen } = chain({ ses_child: "ses_parent", ses_parent: "ses_root" })
      expect(yield* rootSessionID("ses_child", lookup)).toBe("ses_root")
      // Full chain walked once, root lookup confirms the end.
      expect(seen).toEqual(["ses_child", "ses_parent", "ses_root"])
    }),
  )

  it.effect("stops after ten hops even on a cyclic chain", () =>
    Effect.gen(function* () {
      // a -> b -> a ... would loop forever without the hop bound.
      const { lookup } = chain({ ses_a: "ses_b", ses_b: "ses_a" })
      const result = yield* rootSessionID("ses_a", lookup)
      expect(["ses_a", "ses_b"]).toContain(result)
    }),
  )

  it.effect("keeps the current id when the lookup misses the session row", () =>
    Effect.gen(function* () {
      const lookup = () => Effect.succeed(null)
      expect(yield* rootSessionID("ses_ghost", lookup)).toBe("ses_ghost")
    }),
  )
})

describe("SandboxProvider command resilience helpers", () => {
  test("classifies sandbox-gone errors precisely", () => {
    // Sandbox-level disappearance → rebuild and retry is safe.
    expect(isSandboxGone(new Error("Sandbox is no longer running: ses_x/sb_y"))).toBe(true)
    expect(isSandboxGone(new Error("runInSession failed: Execution exec_1 not found on sandbox sb_y"))).toBe(true)
    expect(isSandboxGone(new Error("Failed to create command session: APIError 404"))).toBe(true)
    expect(isSandboxGone(new Error("runDetached failed: sandbox not found"))).toBe(true)
    // Business-level not-found / other errors → never retry (side effects).
    expect(isSandboxGone(new Error("File not found: /workspace/app.py"))).toBe(false)
    expect(isSandboxGone(new Error("command not found: pnpm"))).toBe(false)
    expect(isSandboxGone(new Error("get or create sandbox timed out after 90s"))).toBe(false)
  })

  test("keeps missing command contexts distinct from a missing sandbox", () => {
    expect(isCommandSessionGone(new Error("SandboxApiException: error running in session. context not found"))).toBe(true)
    expect(isCommandSessionGone(new Error("runInSession failed: command session cmd_1 not found (empty execution stream)"))).toBe(true)
    expect(isCommandSessionGone(new Error("File not found: /workspace/app.py"))).toBe(false)
    expect(isCommandSessionGone(new Error("Sandbox is no longer running: ses_x/sb_y"))).toBe(false)
  })

  it.live("fails an operation that exceeds its budget, naming the operation", () =>
    Effect.gen(function* () {
      const exit = yield* withOperationTimeout(Effect.never, 0.02, "get or create sandbox").pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("get or create sandbox timed out after 0.02s")
      }
    }),
  )

  it.live("returns a completed operation before the timeout", () =>
    Effect.gen(function* () {
      const value = yield* withOperationTimeout(Effect.succeed("ok"), 1, "op")
      expect(value).toBe("ok")
    }),
  )

  // The outer budget is timeoutSeconds + grace, so the permit wait must outlast a
  // permit held for the caller's own exec timeout.
  it.live("times out while waiting for a command semaphore permit", () =>
    Effect.gen(function* () {
      const semaphore = yield* Semaphore.make(1)
      const acquired = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const holder = yield* semaphore
        .withPermits(1)(
          Effect.gen(function* () {
            yield* Deferred.succeed(acquired, undefined)
            yield* Deferred.await(release)
          }),
        )
        .pipe(Effect.forkScoped)
      yield* Deferred.await(acquired)

      const exit = yield* withSemaphoreWaitTimeout(semaphore, Effect.succeed("ready"), 0.05, "command queue wait").pipe(
        Effect.exit,
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("command queue wait timed out after 5.05s")
      }

      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(holder)
    }),
    15000,
  )
})
