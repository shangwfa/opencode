import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Semaphore } from "effect"
import { isSandboxGone, withCommandOperationTimeout, withCommandSemaphoreTimeout } from "../../src/tool/sandbox-provider"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

describe("SandboxProvider command operation timeout", () => {
  it.live("does not alter an operation when timeout is undefined", () =>
    Effect.gen(function* () {
      const result = yield* withCommandOperationTimeout(Effect.succeed("ready"), undefined, "create session")
      expect(result).toBe("ready")
    }),
  )

  it.live("fails a stuck operation with the operation name", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(withCommandOperationTimeout(Effect.never, 0.01, "create command session"))
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        expect(Cause.prettyErrors(result.cause).join("\n")).toContain("create command session timed out after 0.01s")
      }
    }),
  )

  it.live("returns a completed operation before the timeout", () =>
    Effect.gen(function* () {
      const result = yield* withCommandOperationTimeout(Effect.succeed("created"), 1, "create session")
      expect(result).toBe("created")
    }),
  )

  // 外层预算 = timeoutSeconds + COMMAND_QUEUE_GRACE_SECONDS(5)，故用例需 >5s
  it.live("times out while waiting for a command semaphore permit", () =>
    Effect.gen(function* () {
      const semaphore = yield* Semaphore.make(1)
      const acquired = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const holder = yield* semaphore.withPermit(
        Effect.gen(function* () {
          yield* Deferred.succeed(acquired, undefined)
          yield* Deferred.await(release)
        }),
      ).pipe(Effect.forkScoped)
      yield* Deferred.await(acquired)

      const result = yield* Effect.exit(
        withCommandSemaphoreTimeout(semaphore, Effect.succeed("ready"), 0.05, "command queue wait"),
      )
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        expect(Cause.prettyErrors(result.cause).join("\n")).toContain("command queue wait timed out after 5.05s")
      }

      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(holder)
    }),
    { timeout: 15000 },
  )

  it.live("classifies sandbox-gone errors precisely", () =>
    Effect.gen(function* () {
      // 沙箱级消失 → 需要重建重试
      expect(isSandboxGone(new Error("Sandbox is no longer running: ses_x/sb_y"))).toBe(true)
      expect(
        isSandboxGone(new Error("runInSession failed: Error: Execution exec_1 not found on sandbox sb_y")),
      ).toBe(true)
      expect(isSandboxGone(new Error("Failed to create command session: APIError 404"))).toBe(true)
      expect(isSandboxGone(new Error("runDetached failed: sandbox not found"))).toBe(true)
      // 业务级 not found / 其他错误 → 绝不重试（避免副作用重复执行）
      expect(isSandboxGone(new Error("File not found: /workspace/app.py"))).toBe(false)
      expect(isSandboxGone(new Error("command not found: pnpm"))).toBe(false)
      expect(isSandboxGone(new Error("Command timed out after 2s"))).toBe(false)
      expect(isSandboxGone(new Error("get or create sandbox timed out after 90s"))).toBe(false)
    }),
  )
})
