import { expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { GlobTool } from "../../src/tool/glob"
import { GrepTool } from "../../src/tool/grep"
import { Truncate } from "../../src/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { Plugin } from "../../src/plugin"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import * as CrossSpawnSpawner from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { SandboxProvider } from "../../src/tool/sandbox-provider"
import { SessionID, MessageID } from "../../src/session/schema"
import { provideTestInstance, disposeAllInstances } from "../fixture/fixture"
import { ConnectionConfig, Sandbox } from "@alibaba-group/opensandbox"

const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    CrossSpawnSpawner.defaultLayer,
    AppFileSystem.defaultLayer,
    Plugin.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
    Ripgrep.defaultLayer,
    SandboxProvider.defaultLayer,
  ),
)

const TEST_IMAGE = process.env["OPENCODE_SANDBOX_IMAGE"] || "opensandbox/code-interpreter-rg"
const TEST_DOMAIN = process.env["OPENCODE_SANDBOX_DOMAIN"] || "localhost:8080"

async function createTestSandbox(sessionID: string = "ses_test"): Promise<Sandbox> {
  const config = new ConnectionConfig({ domain: TEST_DOMAIN, protocol: "http" })
  const sb = await Sandbox.create({
    connectionConfig: config,
    image: TEST_IMAGE,
    timeoutSeconds: 60,
  })
  await sb.commands.run(
    "mkdir -p /workspace/subdir \u0026\u0026 echo 'hello sandbox' \u003e /workspace/test.txt \u0026\u0026 echo 'goodbye sandbox' \u003e /workspace/subdir/other.txt"
  )
  await runtime.runPromise(
    Effect.gen(function* () {
      const provider = yield* SandboxProvider.Service
      return yield* provider.register(SessionID.make(sessionID), sb)
    }) as any,
  )
  return sb
}

function makeCtx(sandbox: Sandbox) {
  return {
    sessionID: SessionID.make("ses_test"),
    messageID: MessageID.make("msg_test"),
    agent: "test-agent",
    abort: AbortSignal.any([]),
    callID: "call_test",
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
    sandbox: Promise.resolve(sandbox) as Promise<any>,
  }
}

function initTool(tool: typeof GlobTool | typeof GrepTool): Promise<any> {
  return runtime.runPromise(tool.pipe(Effect.flatMap((info: any) => info.init())) as any)
}

test("glob executes in sandbox and returns sandbox paths", async () => {
  const sb = await createTestSandbox()
  try {
    const glob = await initTool(GlobTool)
    const ctx = makeCtx(sb)
    await provideTestInstance({
      directory: process.cwd(),
      fn: async () => {
        const result: any = await runtime.runPromise(glob.execute({ pattern: "*.txt", path: "/workspace" }, ctx))
        expect(result.output).toContain("test.txt")
        expect(result.output).toContain("subdir/other.txt")
      },
    })
  } finally {
    await sb.kill().catch(() => {})
    await sb.close().catch(() => {})
  }
})

test("grep executes in sandbox and finds text", async () => {
  const sb = await createTestSandbox()
  try {
    const grep = await initTool(GrepTool)
    const ctx = makeCtx(sb)
    await provideTestInstance({
      directory: process.cwd(),
      fn: async () => {
        const result: any = await runtime.runPromise(grep.execute({ pattern: "hello", path: "/workspace" }, ctx))
        expect(result.output).toContain("test.txt")
        expect(result.output).toContain("hello sandbox")
      },
    })
  } finally {
    await sb.kill().catch(() => {})
    await sb.close().catch(() => {})
  }
})
