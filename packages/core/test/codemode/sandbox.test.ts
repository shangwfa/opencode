import { describe, expect } from "bun:test"
import { readdirSync } from "node:fs"
import { join } from "node:path"
import { CodeModeSandbox } from "@opencode/core/codemode/sandbox"
import { Environment } from "@opencode/core/environment/index"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Cause, Effect, Exit, Layer } from "effect"
import { it } from "../lib/effect"
import { hostEnvironmentLayer, recordingEnvironmentLayer } from "../fixture/environment"

// Production spawns `node <bundled agent>`; tests rewrite the seam to Bun
// running the TypeScript entrypoint so no build artifact is required.
const AGENT_ENTRY = join(import.meta.dir, "../../../codemode/agent.ts")

const rewriteSpawnLayer = (rewrite: (command: ChildProcess.Command) => ChildProcess.Command) =>
  Layer.effect(
    Environment.Service,
    Effect.gen(function* () {
      const environment = yield* Environment.Service
      return Environment.Service.of({
        ...environment,
        spawner: ChildProcessSpawner.make((command) => environment.spawner.spawn(rewrite(command))),
      })
    }),
  ).pipe(Layer.provide(hostEnvironmentLayer))

const runAgentFromSource = rewriteSpawnLayer((command) => {
  if (!ChildProcess.isStandardCommand(command)) return command
  return ChildProcess.make(process.execPath, [AGENT_ENTRY], { ...command.options })
})

const exitImmediatelyLayer = rewriteSpawnLayer(() =>
  ChildProcess.make(process.execPath, ["-e", "process.exit(0)"]),
)

const sandboxLayer = CodeModeSandbox.layer.pipe(Layer.provide(runAgentFromSource))

const run = (input: Parameters<CodeModeSandbox.Interface["run"]>[0]) =>
  Effect.gen(function* () {
    const sandbox = yield* CodeModeSandbox.Service
    return yield* sandbox.run(input)
  }).pipe(Effect.provide(sandboxLayer))

describe("CodeModeSandbox", () => {
  it.effect("runs a program and returns its value", () =>
    Effect.gen(function* () {
      const result = yield* run({ code: "return 1 + 1", tools: [], bridge: { call: () => Effect.succeed(null) } })
      expect(result).toEqual({ ok: true, value: 2, toolCalls: [] })
    }))

  it.effect("routes tool calls through the bridge in order with row callbacks", () =>
    Effect.gen(function* () {
      const rows: Array<[string, boolean]> = []
      const calls: Array<{ tool: string; input: unknown }> = []
      const result = yield* run({
        code: `const a = await tools.test.echo({ v: 1 }); const b = await tools.test.echo({ v: 2 }); return a.v + b.v`,
        tools: [{ path: "test.echo", description: "returns its input" }],
        bridge: {
          onStart: (tool, input) =>
            Effect.sync(() => {
              calls.push({ tool, input })
              rows.push([tool, true])
            }),
          onEnd: (tool, ok) =>
            Effect.sync(() => {
              rows.push([tool, ok])
            }),
          call: (tool, input) => {
            expect(tool).toBe("test.echo")
            return Effect.succeed(input)
          },
        },
      })
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error("expected success")
      expect(result.value).toBe(3)
      expect(calls).toEqual([
        { tool: "test.echo", input: { v: 1 } },
        { tool: "test.echo", input: { v: 2 } },
      ])
      expect(rows).toEqual([
        ["test.echo", true],
        ["test.echo", true],
        ["test.echo", true],
        ["test.echo", true],
      ])
    }))

  it.effect("propagates bridge failures into the program as a ToolFailure", () =>
    Effect.gen(function* () {
      const endings: Array<boolean> = []
      const result = yield* run({
        code: `await tools.test.boom({}); return null`,
        tools: [{ path: "test.boom", description: "always fails" }],
        bridge: {
          onEnd: (tool, ok) =>
            Effect.sync(() => {
              endings.push(ok)
            }),
          call: () => Effect.fail(new Error("boom")),
        },
      })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.kind).toBe("ToolFailure")
        expect(result.error.message).toBe("boom")
      }
      expect(endings).toEqual([false])
    }))

  it.effect("reports a SandboxError when the agent exits without a result", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Effect.gen(function* () {
          const sandbox = yield* CodeModeSandbox.Service
          return yield* sandbox.run({ code: "return 1", tools: [], bridge: { call: () => Effect.succeed(null) } })
        }).pipe(Effect.provide(CodeModeSandbox.layer.pipe(Layer.provide(exitImmediatelyLayer)))),
      )
      if (Exit.isSuccess(exit)) throw new Error("expected the run to fail")
      const error = Cause.squash(exit.cause) as Error
      expect(error.message).toContain("without producing a result")
    }))

  it.effect("spawns node with the configured agent path and a fresh bridge directory", () =>
    Effect.gen(function* () {
      const spawns: Array<ChildProcess.Command> = []
      const exit = yield* Effect.exit(
        Effect.gen(function* () {
          const sandbox = yield* CodeModeSandbox.Service
          return yield* sandbox.run({ code: "return 1", tools: [], bridge: { call: () => Effect.succeed(null) } })
        }).pipe(
          Effect.provide(CodeModeSandbox.layer.pipe(Layer.provide(recordingEnvironmentLayer(spawns)))),
        ),
      )
      expect(spawns).toHaveLength(1)
      const command = spawns[0]
      if (!command || !ChildProcess.isStandardCommand(command)) throw new Error("Expected a standard process command")
      expect(command.command).toBe("node")
      expect(command.args).toHaveLength(1)
      expect(typeof command.args[0]).toBe("string")
      expect(command.options.extendEnv).toBe(false)
      const dir = command.options.env?.["OPENCODE_CODEMODE_DIR"] as string
      expect(dir).toMatch(/^\/tmp\/opencode-codemode-/)
      // The default agent path does not exist on the test host; only the spawn seam matters here.
      expect(Exit.isSuccess(exit)).toBe(false)
    }))

  it.effect("cleans up its protocol directory", () =>
    Effect.gen(function* () {
      const before = new Set(readdirSync("/tmp").filter((name) => name.startsWith("opencode-codemode-")))
      yield* run({ code: `await tools.test.echo({}); return null`, tools: [{ path: "test.echo", description: "x" }], bridge: { call: () => Effect.succeed({ v: 1 }) } })
      const after = readdirSync("/tmp").filter(
        (name) => name.startsWith("opencode-codemode-") && !before.has(name),
      )
      expect(after).toEqual([])
    }))
})
