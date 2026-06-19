import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { WriteTool } from "../../src/tool/write"
import { LSP } from "@/lsp/lsp"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Bus } from "../../src/bus"
import { Format } from "../../src/format"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { Agent } from "../../src/agent/agent"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { SandboxProvider } from "../../src/tool/sandbox-provider"
import type { Sandbox } from "@alibaba-group/opensandbox"

const baseCtx = {
  sessionID: SessionID.make("ses_test-write-session"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

afterEach(async () => {
  await disposeAllInstances()
})

function makeSandbox(writeLog: Array<{ path: string; data: string }>, readResult: string | Error = ""): Sandbox {
  return {
    id: "sandbox-test",
    files: {
      readFile: async () => {
        if (readResult instanceof Error) throw readResult
        return readResult
      },
      writeFiles: async (files: Array<{ path: string; data: string }>) => {
        for (const f of files) writeLog.push(f)
      },
    },
  } as unknown as Sandbox
}

function mockSandboxProvider(sandbox: Sandbox) {
  return Layer.succeed(
    SandboxProvider.Service,
    SandboxProvider.Service.of({
      getOrCreate: () => Effect.succeed(sandbox),
      get: () => Effect.succeed(sandbox),
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
  LSP.defaultLayer,
  AppFileSystem.defaultLayer,
  Bus.layer,
  Format.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  Truncate.defaultLayer,
  Agent.defaultLayer,
)

const it = testEffect(baseLayers)

const init = Effect.fn("WriteToolTest.init")(function* () {
  const info = yield* WriteTool
  return yield* info.init()
})

const run = Effect.fn("WriteToolTest.run")(function* (
  args: Tool.InferParameters<typeof WriteTool>,
  ctx: Tool.Context,
) {
  const tool = yield* init()
  return yield* tool.execute(args, ctx)
})

const makeCtx = (sandbox: Sandbox): Tool.Context => ({
  ...baseCtx,
  sandbox: Promise.resolve(sandbox),
})

describe("tool.write sandbox mode", () => {
  it.instance("writes content to new file", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const written: Array<{ path: string; data: string }> = []
      const sandbox = makeSandbox(written, new Error("file not found"))

      const filepath = path.join(test.directory, "newfile.txt")
      const result = yield* run({ filePath: filepath, content: "Hello, World!" }, makeCtx(sandbox)).pipe(
        Effect.provide(mockSandboxProvider(sandbox)),
      )

      expect(result.output).toContain("Wrote file successfully")
      expect(result.metadata.exists).toBe(false)
      expect(written).toHaveLength(1)
      expect(written[0].path).toContain("newfile.txt")
      expect(written[0].data).toBe("Hello, World!")
    }),
  )

  it.instance("overwrites existing file content", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const written: Array<{ path: string; data: string }> = []
      const sandbox = makeSandbox(written, "old content")

      const filepath = path.join(test.directory, "existing.txt")
      const result = yield* run({ filePath: filepath, content: "new content" }, makeCtx(sandbox)).pipe(
        Effect.provide(mockSandboxProvider(sandbox)),
      )

      expect(result.output).toContain("Wrote file successfully")
      expect(result.metadata.exists).toBe(true)
      expect(written).toHaveLength(1)
      expect(written[0].data).toBe("new content")
    }),
  )

  it.instance("fails when sandbox is not available", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "newfile.txt")

      const exit = yield* run({ filePath: filepath, content: "Hello" }, baseCtx).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
    }),
  )
})
