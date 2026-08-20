import { afterEach, describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer, Duration } from "effect"
import path from "path"
import { Agent } from "../../src/agent/agent"
import * as CrossSpawnSpawner from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import type { Sandbox, FileInfo, Execution, OutputMessage } from "@alibaba-group/opensandbox"
import { disposeAllInstances } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"
import { Instruction } from "../../src/session/instruction"
import { ReadTool } from "../../src/tool/read"
import { Truncate } from "../../src/tool/truncate"
import { Tool } from "../../src/tool/tool"
import { SandboxProvider } from "../../src/tool/sandbox-provider"
import { provideInstance, tmpdirScoped, testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const S_IFDIR = 0o040000
const S_IFREG = 0o100000

function text(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function makeExecution(stdout: string[], exitCode = 0): Execution {
  const logs: OutputMessage[] = stdout.map((t) => ({ text: t, timestamp: 0 }))
  return { logs: { stdout: logs, stderr: [] }, result: [], exitCode }
}

function makeSandbox(files: Map<string, Uint8Array | string>, opts?: { rejectReadBytes?: string }): Sandbox {
  const fileMap = new Map<string, Uint8Array>()
  for (const [k, v] of files) fileMap.set(k, typeof v === "string" ? text(v) : v)
  const sb = {
    files: {
      getFileInfo: async (paths: string[]) => {
        const result: Record<string, FileInfo> = {}
        for (const p of paths) {
          const data = fileMap.get(p)
          if (data) result[p] = { path: p, mode: S_IFREG, size: data.length }
          else if ([...fileMap.keys()].some((k) => k.startsWith(p + "/"))) result[p] = { path: p, mode: S_IFDIR, size: 4096 }
        }
        return result
      },
      readBytes: async (p: string, o?: { range?: string }) => {
        if (opts?.rejectReadBytes === p) throw new Error(`read failed: ${p}`)
        const data = fileMap.get(p)
        if (!data) throw new Error(`File not found: ${p}`)
        if (o?.range) {
          const m = o.range.match(/bytes=(\d+)-(\d*)/)
          if (m) return data.subarray(Number(m[1]), m[2] ? Number(m[2]) + 1 : data.length)
        }
        return data
      },
      readBytesStream: async function* (p: string) {
        const data = fileMap.get(p)
        if (!data) throw new Error(`File not found: ${p}`)
        yield data
      },
      createDirectories: async () => {},
      deleteFiles: async (paths: string[]) => {
        paths.forEach((p) => fileMap.delete(p))
      },
      writeFiles: async (entries: Array<{ path: string; data?: unknown }>) => {
        for (const entry of entries) {
          if (typeof entry.data === "string") fileMap.set(entry.path, text(entry.data))
          else if (entry.data instanceof Uint8Array) fileMap.set(entry.path, entry.data)
        }
      },
    },
  } as unknown as Sandbox
  return sb
}

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
      isSnapshotSession: () => Effect.succeed(false),
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
  LayerNode.compile(Instruction.node),
  LayerNode.compile(Truncate.node),
  testInstanceStoreLayer,
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

describe("tool.read sandbox mode - directory listing", () => {
  it.live("fails when directory listing runInSession returns non-zero exit code", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const sb = makeSandbox(new Map([["/workspace/src/a.txt", text("x")]]))
      const ctx = makeCtx(Promise.resolve(sb))
      const provider = mockSandboxProvider(() =>
        Effect.succeed(makeExecution(["permission denied"], 1)),
      )

      const exit = yield* Effect.exit(exec(dir, { filePath: path.join(dir, "src") }, ctx, provider))

      expect(Exit.isSuccess(exit)).toBe(false)
      const err = Cause.squash((exit as any).cause)
      const errMsg = err instanceof Error ? err.message : String(err)
      expect(errMsg).toContain("Failed to list directory")
    }),
  )

  it.live("returns directory listing for a directory path", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const sb = makeSandbox(
        new Map([
          ["/workspace/src/file1.txt", text("a")],
          ["/workspace/src/file2.ts", text("b")],
        ]),
      )
      const ctx = makeCtx(Promise.resolve(sb))
      const provider = mockSandboxProvider(() =>
        Effect.succeed(makeExecution(["file1.txt", "file2.ts"], 0)),
      )

      const result = yield* exec(dir, { filePath: path.join(dir, "src") }, ctx, provider)

      expect(result.output).toContain("directory")
      expect(result.output).toContain("file1.txt")
      expect(result.output).toContain("file2.ts")
    }),
  )
})

describe("tool.read sandbox mode - file content", () => {
  it.live("returns file content when readBytes succeeds", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const sb = makeSandbox(new Map([["/workspace/test.txt", text("hello from sandbox")]]))
      const ctx = makeCtx(Promise.resolve(sb))
      const provider = mockSandboxProvider(() => Effect.succeed(makeExecution([], 0)))

      const result = yield* exec(dir, { filePath: path.join(dir, "test.txt") }, ctx, provider)

      expect(result.output).toContain("hello from sandbox")
      expect(result.output).toContain("<type>file</type>")
    }),
  )

  it.live("throws error when readBytes rejects", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const sb = makeSandbox(new Map([["/workspace/missing.txt", text("x")]]), {
        rejectReadBytes: "/workspace/missing.txt",
      })
      const ctx = makeCtx(Promise.resolve(sb))
      const provider = mockSandboxProvider(() => Effect.succeed(makeExecution([], 0)))

      const exit = yield* Effect.exit(exec(dir, { filePath: path.join(dir, "missing.txt") }, ctx, provider))

      expect(Exit.isSuccess(exit)).toBe(false)
      const err = Cause.squash((exit as any).cause)
      const errMsg = err instanceof Error ? err.message : String(err)
      expect(errMsg).toContain("Cannot read file")
    }),
  )
})

describe("Effect.timeoutOrElse wiring", () => {
  it.live("triggers orElse when effect exceeds duration", () =>
    Effect.gen(function* () {
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
