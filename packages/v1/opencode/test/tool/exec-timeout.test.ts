import { describe, it, expect } from "bun:test"
import { Effect, Duration } from "effect"
import { withExecTimeout } from "../../src/tool/sandbox-provider"
import type { CommandExecution } from "@alibaba-group/opensandbox"

const normalResult: CommandExecution = {
  logs: { stdout: [{ text: "hello\n", timestamp: Date.now() }], stderr: [] },
  result: [],
  exitCode: 0,
}

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

describe("withExecTimeout", () => {
  describe("no timeout when timeoutSeconds is falsy", () => {
    it("undefined → passthrough, returns original result", async () => {
      const program = withExecTimeout(Effect.succeed(normalResult), undefined)
      const result = await run(program)
      expect(result).toBe(normalResult)
    })

    it("0 → passthrough, returns original result", async () => {
      const program = withExecTimeout(Effect.succeed(normalResult), 0)
      const result = await run(program)
      expect(result).toBe(normalResult)
    })
  })

  describe("returns original result when effect completes before timeout", () => {
    it("fast effect with timeoutSeconds=10 returns normal exitCode=0", async () => {
      const program = withExecTimeout(Effect.succeed(normalResult), 10)
      const result = await run(program)
      expect(result).toBe(normalResult)
      expect(result.exitCode).toBe(0)
    })
  })

  describe("returns timeout result when effect exceeds timeout", () => {
    it("slow effect with timeoutSeconds=1 returns exitCode=null and TimeoutError", async () => {
      const slow = Effect.sleep(Duration.seconds(60)).pipe(Effect.map(() => normalResult))
      const program = withExecTimeout(slow as Effect.Effect<CommandExecution, Error>, 1)
      const result = await run(program)
      expect(result.exitCode).toBe(null)
      expect(result.error).toBeDefined()
      expect(result.error!.name).toBe("TimeoutError")
      expect(result.error!.value).toContain("1s")
      expect(result.logs.stdout).toEqual([])
      expect(result.logs.stderr).toEqual([])
    })

    it("timeout error value includes the timeout seconds", async () => {
      const slow = Effect.sleep(Duration.seconds(60)).pipe(Effect.map(() => normalResult))
      const program = withExecTimeout(slow as Effect.Effect<CommandExecution, Error>, 3)
      const result = await run(program)
      expect(result.error!.value).toBe("Command timed out after 3s")
    })

    it("timeout result has empty traceback", async () => {
      const slow = Effect.sleep(Duration.seconds(60)).pipe(Effect.map(() => normalResult))
      const program = withExecTimeout(slow as Effect.Effect<CommandExecution, Error>, 1)
      const result = await run(program)
      expect(result.error!.traceback).toEqual([])
    })
  })

  describe("propagates errors from underlying effect", () => {
    it("effect failure propagates as Failure exit", async () => {
      const failing = Effect.fail(new Error("sandbox exploded"))
      const program = withExecTimeout(failing, 10)
      const exit = await run(program.pipe(Effect.exit))
      expect(exit._tag).toBe("Failure")
    })
  })
})
