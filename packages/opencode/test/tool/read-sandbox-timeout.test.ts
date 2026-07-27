import { afterEach, describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer, Duration } from "effect"
import path from "path"
import { Agent } from "../../src/agent/agent"
import * as CrossSpawnSpawner from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
// TODO: merge-upstream — FileTime module removed
// import { FileTime } from "../../src/file/time"
// TODO: merge-upstream — LSP namespace removed; use named imports from ../../src/lsp/lsp
// import { LSP } from "../../src/lsp"
import { provideTestInstance, disposeAllInstances } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"
import { Instruction } from "../../src/session/instruction"
import { ReadTool } from "../../src/tool/read"
import { Truncate } from "../../src/tool/truncate"
import { Tool } from "../../src/tool/tool"
import { SandboxProvider } from "../../src/tool/sandbox-provider"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const makeCtx = (sandbox: Promise<any>): Tool.Context => ({
  sessionID: SessionID.make("ses_timeout_test"),
  messageID: MessageID.make("msg_timeout_test"),
  agent: "build",
  abort: AbortSignal.any([]),
  callID: "call_timeout_test",
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
  sandbox,
})

function mockSandboxProvider(runInSessionFn: (sessionID: string, command: string) => Effect.Effect<any, Error>) {
  return Layer.succeed(
    SandboxProvider.Service,
    SandboxProvider.Service.of({
      getOrCreate: () => Effect.succeed(null as any),
      get: () => Effect.succeed(null),
      destroy: () => Effect.void,
      destroyById: () => Effect.void,
      destroyAll: () => Effect.void,
      runInSession: runInSessionFn,
      register: () => Effect.void,
      keepAlive: () => Effect.void,
      touch: () => Effect.void,
      release: () => Effect.void,
      isKeepAlive: () => Effect.succeed(false),
      getEndpoint: () => Effect.die(new Error("not implemented")),
      cleanupSessionVolume: () => Effect.void,
      runDetached: () => Effect.succeed({} as any),
      interrupt: () => Effect.void,
    }),
  )
}

const baseLayers = Layer.mergeAll(
  Agent.defaultLayer,
  AppFileSystem.defaultLayer,
  LayerNode.compile(CrossSpawnSpawner.node),
  // TODO: FileTime removed
//   FileTime.defaultLayer,
  LayerNode.compile(Instruction.node),
  // TODO: LSP removed
//   LSP.defaultLayer,
  LayerNode.compile(Truncate.node),
)

const it = testEffect(baseLayers as any)

const init = Effect.fn("ReadSandboxTimeoutTest.init")(function* () {
  const info = yield* ReadTool
  return yield* info.init()
})

const exec = Effect.fn("ReadSandboxTimeoutTest.exec")(function* (
  dir: string,
  args: Tool.InferParameters<typeof ReadTool>,
  ctx: Tool.Context,
  provider: Layer.Layer<SandboxProvider.Service>,
) {
  const tool = yield* init().pipe(Effect.provide(provider))
  return yield* provideInstance(dir)(tool.execute(args, ctx))
})

describe("tool.read sandbox mode - test -d failure handling", () => {
  it.live("fails when runInSession (test -d) rejects instead of silently degrading", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()

      const sandboxPromise = Promise.resolve({
        files: { readFile: () => new Promise(() => {}) },
      })
      const ctx = makeCtx(sandboxPromise)

      const provider = mockSandboxProvider(() =>
        Effect.fail(new Error("Sandbox not found for session ses_timeout_test")),
      )

      // orDie converts fail to die (unrecoverable), Effect.exit still catches it
      const exit = yield* Effect.exit(exec(dir, { filePath: path.join(dir, "test.txt") }, ctx, provider))

      expect(Exit.isSuccess(exit)).toBe(false)
      const err = Cause.squash((exit as any).cause)
      const errMsg = err instanceof Error ? err.message : String(err)
      expect(errMsg).toContain("Failed to check path type in sandbox")
    }),
  )

  it.live("returns directory listing when runInSession returns DIR", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()

      const sandboxPromise = Promise.resolve({
        files: { readFile: () => Promise.resolve("should not be called") },
      })
      const ctx = makeCtx(sandboxPromise)

      let callCount = 0
      const provider = mockSandboxProvider((_sid: string, command: string) =>
        Effect.gen(function* () {
          callCount++
          if (command.includes("test -d")) {
            return { logs: { stdout: [{ text: "DIR" }], stderr: [] }, exitCode: 0 }
          }
          return {
            logs: { stdout: [{ text: "file1.txt" }, { text: "file2.ts" }], stderr: [] },
            exitCode: 0,
          }
        }),
      )

      const result = yield* exec(dir, { filePath: path.join(dir, "src") }, ctx, provider)

      expect(result.output).toContain("directory")
      expect(result.output).toContain("file1.txt")
      expect(result.output).toContain("file2.ts")
    }),
  )

  it.live("returns file content when runInSession returns FILE and readFile succeeds", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()

      const sandboxPromise = Promise.resolve({
        files: { readFile: () => Promise.resolve("hello from sandbox") },
      })
      const ctx = makeCtx(sandboxPromise)

      const provider = mockSandboxProvider(() =>
        Effect.succeed({ logs: { stdout: [{ text: "FILE" }], stderr: [] }, exitCode: 0 }),
      )

      const result = yield* exec(dir, { filePath: path.join(dir, "test.txt") }, ctx, provider)

      expect(result.output).toContain("hello from sandbox")
      expect(result.output).toContain("<type>file</type>")
    }),
  )
})

describe("tool.read sandbox mode - readFile failure with timeout", () => {
  it.live("throws error when sb.files.readFile rejects (file not found scenario)", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()

      const sandboxPromise = Promise.resolve({
        files: {
          readFile: () => Promise.reject(new Error("file not found")),
        },
      })
      const ctx = makeCtx(sandboxPromise)

      const provider = mockSandboxProvider(() =>
        Effect.succeed({ logs: { stdout: [{ text: "FILE" }], stderr: [] }, exitCode: 0 }),
      )

      // orDie makes this throw, Effect.exit catches it
      const exit = yield* Effect.exit(
        exec(dir, { filePath: path.join(dir, "missing.txt") }, ctx, provider),
      )

      expect(Exit.isSuccess(exit)).toBe(false)
      const err = Cause.squash((exit as any).cause)
      const errMsg = err instanceof Error ? err.message : String(err)
      // tryPromise catch throws "File not found in sandbox"
      // timeoutOrElse triggers "Timeout reading file in sandbox" on hang
      expect(errMsg).toMatch(/File not found in sandbox|Timeout reading file in sandbox/)
    }),
  )
})

describe("Effect.timeoutOrElse wiring", () => {
  it.live("triggers orElse when effect exceeds duration", () =>
    Effect.gen(function* () {
      // Verify the timeout mechanism works independently of read.ts
      const result = yield* Effect.gen(function* () {
        return yield* Effect.never.pipe(
          Effect.timeoutOrElse({
            duration: Duration.millis(100),
            orElse: () => Effect.succeed("timed out"),
          }),
        )
      })

      expect(result).toBe("timed out")
    }),
  )
})
