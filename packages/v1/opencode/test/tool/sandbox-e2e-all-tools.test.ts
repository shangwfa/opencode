// E2E: 6 tools (bash→write→read→edit→glob→grep) in the SAME sandbox.
import { expect, test, describe, beforeAll, afterAll } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { GlobTool } from "../../src/tool/glob"
import { GrepTool } from "../../src/tool/grep"
import { BashTool } from "@opencode-ai/core/tool/bash"
import { ReadTool } from "../../src/tool/read"
import { WriteTool } from "../../src/tool/write"
import { EditTool } from "../../src/tool/edit"
import { Truncate } from "../../src/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { Plugin } from "../../src/plugin"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import * as CrossSpawnSpawner from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { SandboxProvider } from "../../src/tool/sandbox-provider"
// TODO: merge-upstream — LSP namespace removed; use named imports from ../../src/lsp/lsp
// import { LSP } from "../../src/lsp"
// TODO: merge-upstream — FileTime module removed
// import { FileTime } from "../../src/file/time"
// TODO: merge-upstream — FileWatcher module removed
// import { FileWatcher } from "../../src/file/watcher"
import { Bus } from "../../src/bus"
import { Format } from "../../src/format"
import { Instruction } from "../../src/session/instruction"
import { SessionID, MessageID } from "../../src/session/schema"
import { provideTestInstance, disposeAllInstances } from "../fixture/fixture"
import { ConnectionConfig, Sandbox } from "@alibaba-group/opensandbox"

const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    LayerNode.compile(CrossSpawnSpawner.node),
    AppFileSystem.defaultLayer,
    LayerNode.compile(Plugin.node),
    LayerNode.compile(Truncate.node),
    Agent.defaultLayer,
    LayerNode.compile(Ripgrep.node),
    SandboxProvider.defaultLayer,
    // TODO: LSP removed
//     LSP.defaultLayer,
    // TODO: FileTime removed
//     FileTime.defaultLayer,
    // TODO: FileWatcher removed
//     FileWatcher.defaultLayer,
    Bus.layer,
    LayerNode.compile(Format.node),
    LayerNode.compile(Instruction.node),
  ) as any,
)

const TEST_IMAGE = process.env["OPENCODE_SANDBOX_IMAGE"] || "opensandbox/code-interpreter-rg"
const TEST_DOMAIN = process.env["OPENCODE_SANDBOX_DOMAIN"] || "localhost:8080"
const HOST_HOSTNAME = require("os").hostname()

let sb: Sandbox
let bashTool: any
let writeTool: any
let readTool: any
let editTool: any
let globTool: any
let grepTool: any

function makeCtx(sandbox: Sandbox) {
  return {
    sessionID: SessionID.make("ses_e2e"),
    messageID: MessageID.make("msg_e2e"),
    agent: "e2e-agent",
    abort: AbortSignal.any([]),
    callID: "call_e2e",
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
    sandbox: Promise.resolve(sandbox) as Promise<any>,
  }
}

beforeAll(async () => {
  const config = new ConnectionConfig({ domain: TEST_DOMAIN, protocol: "http" })
  sb = await Sandbox.create({
    connectionConfig: config,
    image: TEST_IMAGE,
    timeoutSeconds: 120,
  })
  await sb.commands.run("mkdir -p /workspace/subdir")
  await sb.files.writeFiles([
    { path: "/workspace/subdir/preexisting.txt", data: "pre-existing content for grep" },
  ])

  await runtime.runPromise(
    Effect.gen(function* () {
      const provider = yield* SandboxProvider.Service
      return yield* provider.register(SessionID.make("ses_e2e"), sb)
    }) as any,
  )

  await provideTestInstance({
    directory: process.cwd(),
    fn: async () => {
      const init = (tool: any) => runtime.runPromise(Effect.scoped(tool.pipe(Effect.flatMap((info: any) => info.init()))) as any)
      bashTool = await init(BashTool)
      writeTool = await init(WriteTool)
      readTool = await init(ReadTool)
      editTool = await init(EditTool)
      globTool = await init(GlobTool)
      grepTool = await init(GrepTool)
    },
  })
}, 60_000)

afterAll(async () => {
  await runtime.dispose()
  if (sb) {
    await sb.kill().catch(() => {})
    await sb.close().catch(() => {})
  }
})

const run = (effect: any) => runtime.runPromise(Effect.scoped(effect) as any)

describe("Sandbox E2E — all 6 tools in one sandbox", () => {
  test("1. bash — runs inside container", async () => {
    const ctx = makeCtx(sb)
    await provideTestInstance({
      directory: process.cwd(),
      fn: async () => {
        const result: any = await run(
          bashTool.execute({ command: "hostname", description: "get hostname", timeout: 10000 }, ctx),
        )
        expect(result.output).toBeDefined()
        const hostname = result.output.trim()
        expect(hostname).not.toBe(HOST_HOSTNAME)
        expect(hostname.length).toBeGreaterThan(0)
      },
    })
  })

  test("2. write — creates file in sandbox", async () => {
    const ctx = makeCtx(sb)
    await provideTestInstance({
      directory: process.cwd(),
      fn: async () => {
        const result: any = await run(
          writeTool.execute({ filePath: "e2e-test.txt", content: "Hello World" }, ctx),
        )
        expect(result.output).toContain("Wrote file successfully")
      },
    })
  })

  test("3. read — reads back the written file", async () => {
    const ctx = makeCtx(sb)
    await provideTestInstance({
      directory: process.cwd(),
      fn: async () => {
        const result: any = await run(
          readTool.execute({ filePath: "e2e-test.txt" }, ctx),
        )
        expect(result.output).toContain("Hello World")
      },
    })
  })

  test("4. edit — replaces content in sandbox", async () => {
    const ctx = makeCtx(sb)
    await provideTestInstance({
      directory: process.cwd(),
      fn: async () => {
        const result: any = await run(
          editTool.execute(
            { filePath: "e2e-test.txt", oldString: "Hello World", newString: "Hello Sandbox" },
            ctx,
          ),
        )
        expect(result.output).toContain("Edit applied")
      },
    })
  })

  test("5. glob — finds .txt files in sandbox", async () => {
    const ctx = makeCtx(sb)
    await provideTestInstance({
      directory: process.cwd(),
      fn: async () => {
        const result: any = await run(
          globTool.execute({ pattern: "*.txt", path: "." }, ctx),
        )
        expect(result.output).toContain("e2e-test.txt")
        expect(result.output).toContain("preexisting.txt")
      },
    })
  })

  test("6. grep — searches content in sandbox", async () => {
    const ctx = makeCtx(sb)
    await provideTestInstance({
      directory: process.cwd(),
      fn: async () => {
        const result: any = await run(
          grepTool.execute({ pattern: "Sandbox", path: "." }, ctx),
        )
        expect(result.output).toContain("e2e-test.txt")
        expect(result.output).toContain("Sandbox")
      },
    })
  })
})
