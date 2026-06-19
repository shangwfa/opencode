import { afterEach, describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer, Duration } from "effect"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { LSP } from "@/lsp/lsp"
import { SessionID, MessageID } from "../../src/session/schema"
import { Instruction } from "../../src/session/instruction"
import { ReadTool } from "../../src/tool/read"
import { Truncate } from "../../src/tool/truncate"
import { Tool } from "@/tool/tool"
import { SandboxProvider } from "../../src/tool/sandbox-provider"
import { disposeAllInstances, provideInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Reference } from "@/reference/reference"
import { RepositoryCache } from "@/reference/repository-cache"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import type { Sandbox } from "@alibaba-group/opensandbox"

afterEach(async () => {
  await disposeAllInstances()
})

function makeSandbox(readResult: string | Error = ""): Sandbox {
  return {
    id: "sandbox-test",
    files: {
      readFile: async () => {
        if (readResult instanceof Error) throw readResult
        return readResult
      },
    },
  } as unknown as Sandbox
}

function makeCtx(sandbox: Sandbox): Tool.Context {
  return {
    sessionID: SessionID.make("ses_timeout_test"),
    messageID: MessageID.make("msg_timeout_test"),
    agent: "build",
    abort: AbortSignal.any([]),
    callID: "call_timeout_test",
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
    sandbox: Promise.resolve(sandbox),
  }
}

function mockSandboxProvider() {
  return Layer.succeed(
    SandboxProvider.Service,
    SandboxProvider.Service.of({
      getOrCreate: () => Effect.die(new Error("not implemented")),
      get: () => Effect.succeed(null),
      destroy: () => Effect.void,
      destroyById: () => Effect.void,
      destroyAll: () => Effect.void,
      runInSession: () => Effect.die(new Error("not implemented")),
      runDetached: () => Effect.die(new Error("not implemented")),
      interrupt: () => Effect.void,
      register: () => Effect.void,
      keepAlive: () => Effect.void,
      release: () => Effect.void,
      isKeepAlive: () => Effect.succeed(false),
      getEndpoint: () => Effect.die(new Error("not implemented")),
      cleanupSessionVolume: () => Effect.void,
    }),
  )
}

const baseLayers = Layer.mergeAll(
  Agent.defaultLayer,
  AppFileSystem.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  Instruction.defaultLayer,
  LSP.defaultLayer,
  Reference.layer.pipe(
    Layer.provide(Config.defaultLayer),
    Layer.provide(RepositoryCache.defaultLayer),
    Layer.provide(RuntimeFlags.layer({})),
  ),
  Truncate.defaultLayer,
)

const it = testEffect(baseLayers)

const init = Effect.fn("ReadSandboxTimeoutTest.init")(function* () {
  const info = yield* ReadTool
  return yield* info.init()
})

const exec = Effect.fn("ReadSandboxTimeoutTest.exec")(function* (
  dir: string,
  args: Tool.InferParameters<typeof ReadTool>,
  ctx: Tool.Context,
) {
  const tool = yield* init().pipe(Effect.provide(mockSandboxProvider()))
  return yield* provideInstance(dir)(tool.execute(args, ctx))
})

describe("tool.read sandbox mode", () => {
  it.live("returns file content via files.readFile", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const sandbox = makeSandbox("hello from sandbox")
      const ctx = makeCtx(sandbox)

      const result = yield* exec(dir, { filePath: path.join(dir, "test.txt") }, ctx)

      expect(result.output).toContain("hello from sandbox")
      expect(result.output).toContain("<type>file</type>")
    }),
  )

  it.live("fails when file does not exist", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const sandbox = makeSandbox(new Error("not found"))
      const ctx = makeCtx(sandbox)

      const exit = yield* Effect.exit(exec(dir, { filePath: path.join(dir, "missing.txt") }, ctx))

      expect(Exit.isSuccess(exit)).toBe(false)
      if (!Exit.isFailure(exit)) return
      const err = Cause.squash(exit.cause)
      const errMsg = err instanceof Error ? err.message : String(err)
      expect(errMsg).toContain("File not found:")
    }),
  )
})

describe("Effect.timeoutOrElse wiring", () => {
  it.live("triggers orElse when effect exceeds duration", () =>
    Effect.gen(function* () {
      const result = yield* Effect.never.pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(100),
          orElse: () => Effect.succeed("timed out"),
        }),
      )

      expect(result).toBe("timed out")
    }),
  )
})
