/**
 * Benchmark: Local execution vs Sandbox execution for all 6 tools.
 *
 * Usage:
 *   OPENCODE_SANDBOX_IMAGE=opensandbox/code-interpreter-rg bun run test/tool/bench-local-vs-sandbox.ts
 */
import { Effect, Layer, ManagedRuntime } from "effect"
import { GlobTool } from "../../src/tool/glob"
import { GrepTool } from "../../src/tool/grep"
import { BashTool } from "../../src/tool/bash"
import { ReadTool } from "../../src/tool/read"
import { WriteTool } from "../../src/tool/write"
import { EditTool } from "../../src/tool/edit"
import { Truncate } from "../../src/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { Plugin } from "../../src/plugin"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Ripgrep } from "../../src/file/ripgrep"
import { SandboxProvider, NoopSandboxProvider } from "../../src/tool/sandbox-provider"
import { LSP } from "../../src/lsp"
import { FileTime } from "../../src/file/time"
import { FileWatcher } from "../../src/file/watcher"
import { Bus } from "../../src/bus"
import { Format } from "../../src/format"
import { Instruction } from "../../src/session/instruction"
import { SessionID, MessageID } from "../../src/session/schema"
import { Instance } from "../../src/project/instance"
import { ConnectionConfig, Sandbox } from "@alibaba-group/opensandbox"
import path from "path"
import fs from "fs"
import os from "os"

const ROUNDS = 3

const TEST_IMAGE = process.env["OPENCODE_SANDBOX_IMAGE"] || "opensandbox/code-interpreter-rg"
const TEST_DOMAIN = process.env["OPENCODE_SANDBOX_DOMAIN"] || "localhost:8080"

// ── Runtimes ──

const sharedLayers = Layer.mergeAll(
  CrossSpawnSpawner.defaultLayer,
  AppFileSystem.defaultLayer,
  Plugin.defaultLayer,
  Truncate.defaultLayer,
  Agent.defaultLayer,
  Ripgrep.defaultLayer,
  LSP.defaultLayer,
  FileTime.defaultLayer,
  FileWatcher.defaultLayer,
  Bus.layer,
  Format.defaultLayer,
  Instruction.defaultLayer,
)

const localRuntime = ManagedRuntime.make(
  Layer.mergeAll(sharedLayers, NoopSandboxProvider.layer),
)
const sandboxRuntime = ManagedRuntime.make(
  Layer.mergeAll(sharedLayers, SandboxProvider.defaultLayer),
)

// ── helpers ──

function localCtx() {
  return {
    sessionID: SessionID.make("ses_local"),
    messageID: MessageID.make("msg_local"),
    agent: "bench-agent",
    abort: AbortSignal.any([]),
    callID: "call_local",
    messages: [] as any[],
    metadata: () => Effect.void,
    ask: () => Effect.void,
    sandbox: null,
  }
}

function sandboxCtx(sb: Sandbox) {
  return {
    sessionID: SessionID.make("ses_sandbox"),
    messageID: MessageID.make("msg_sandbox"),
    agent: "bench-agent",
    abort: AbortSignal.any([]),
    callID: "call_sandbox",
    messages: [] as any[],
    metadata: () => Effect.void,
    ask: () => Effect.void,
    sandbox: Promise.resolve(sb) as Promise<any>,
  }
}

async function time(label: string, fn: () => Promise<any>): Promise<number> {
  const start = performance.now()
  const result = await fn()
  const elapsed = performance.now() - start
  return elapsed
}

type ToolDef = { execute: (args: any, ctx: any) => Effect.Effect<any> }

async function initTools(rt: any): Promise<Record<string, ToolDef>> {
  return Instance.provide({
    directory: process.cwd(),
    fn: async () => {
      const init = (tool: any) =>
        rt.runPromise(Effect.scoped(tool.pipe(Effect.flatMap((info: any) => info.init()))) as any)
      return {
        bash: await init(BashTool),
        write: await init(WriteTool),
        read: await init(ReadTool),
        edit: await init(EditTool),
        glob: await init(GlobTool),
        grep: await init(GrepTool),
      }
    },
  })
}

function runEffect(rt: any, effect: any) {
  return rt.runPromise(Effect.scoped(effect) as any)
}

// ── Setup ──

console.log("╔══════════════════════════════════════════════════════════════╗")
console.log("║     Benchmark: Local vs Sandbox (runInSession) — 6 Tools   ║")
console.log("╚══════════════════════════════════════════════════════════════╝")
console.log(`Rounds: ${ROUNDS}  |  Image: ${TEST_IMAGE}  |  Domain: ${TEST_DOMAIN}`)
console.log()

// Prepare local temp directory
const localTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-local-"))
fs.writeFileSync(path.join(localTmpDir, "preexisting.txt"), "pre-existing content for grep\n")
fs.mkdirSync(path.join(localTmpDir, "subdir"), { recursive: true })
fs.writeFileSync(path.join(localTmpDir, "subdir", "deep.txt"), "deep file content\n")

// Prepare sandbox
console.log("⏳ Creating sandbox...")
const config = new ConnectionConfig({ domain: TEST_DOMAIN, protocol: "http" })
const sb = await Sandbox.create({
  connectionConfig: config,
  image: TEST_IMAGE,
  timeoutSeconds: 120,
})
await sb.commands.run("mkdir -p /workspace/subdir")
await sb.files.writeFiles([
  { path: "/workspace/preexisting.txt", data: "pre-existing content for grep\n" },
  { path: "/workspace/subdir/deep.txt", data: "deep file content\n" },
])

await sandboxRuntime.runPromise(
  Effect.gen(function* () {
    const provider = yield* SandboxProvider.Service
    return yield* provider.register(SessionID.make("ses_sandbox"), sb)
  }) as any,
)
console.log("✅ Sandbox ready:", sb.id)
console.log()

// Init tools
const localTools = await initTools(localRuntime)
const sandboxTools = await initTools(sandboxRuntime)

// ── Benchmark Steps ──

interface BenchStep {
  name: string
  localArgs: any
  sandboxArgs: any
  tool: string
}

const steps: BenchStep[] = [
  {
    name: "bash: echo hello",
    tool: "bash",
    localArgs: { command: "echo hello", description: "echo hello", timeout: 10000 },
    sandboxArgs: { command: "echo hello", description: "echo hello", timeout: 10000 },
  },
  {
    name: "write: create file",
    tool: "write",
    localArgs: { filePath: path.join(localTmpDir, "bench-file.txt"), content: "benchmark content line 1\nbenchmark content line 2\n" },
    sandboxArgs: { filePath: "bench-file.txt", content: "benchmark content line 1\nbenchmark content line 2\n" },
  },
  {
    name: "read: read file",
    tool: "read",
    localArgs: { filePath: path.join(localTmpDir, "bench-file.txt") },
    sandboxArgs: { filePath: "bench-file.txt" },
  },
  {
    name: "edit: replace text",
    tool: "edit",
    localArgs: { filePath: path.join(localTmpDir, "bench-file.txt"), oldString: "benchmark content line 1", newString: "MODIFIED content line 1" },
    sandboxArgs: { filePath: "bench-file.txt", oldString: "benchmark content line 1", newString: "MODIFIED content line 1" },
  },
  {
    name: "glob: find *.txt",
    tool: "glob",
    localArgs: { pattern: "*.txt", path: localTmpDir },
    sandboxArgs: { pattern: "*.txt", path: "." },
  },
  {
    name: "grep: search content",
    tool: "grep",
    localArgs: { pattern: "content", path: localTmpDir },
    sandboxArgs: { pattern: "content", path: "." },
  },
]

// ── Run Benchmarks ──

type Result = { step: string; localMs: number[]; sandboxMs: number[] }
const results: Result[] = []

for (const step of steps) {
  const localTimes: number[] = []
  const sandboxTimes: number[] = []

  for (let r = 0; r < ROUNDS; r++) {
    const editFile = `bench-edit-r${r}.txt`
    const editContent = "benchmark content line 1\nbenchmark content line 2\n"

    if (step.tool === "edit") {
      fs.writeFileSync(path.join(localTmpDir, editFile), editContent)
      await sb.files.writeFiles([{ path: `/workspace/${editFile}`, data: editContent }])
      await Instance.provide({
        directory: localTmpDir,
        fn: () => runEffect(localRuntime, (localTools as any).read.execute({ filePath: path.join(localTmpDir, editFile) }, localCtx())),
      })
      await Instance.provide({
        directory: process.cwd(),
        fn: () => runEffect(sandboxRuntime, (sandboxTools as any).read.execute({ filePath: editFile }, sandboxCtx(sb))),
      })
      step.localArgs = { filePath: path.join(localTmpDir, editFile), oldString: "benchmark content line 1", newString: "MODIFIED content line 1" }
      step.sandboxArgs = { filePath: editFile, oldString: "benchmark content line 1", newString: "MODIFIED content line 1" }
    }

    const localMs = await time(`local:${step.name}`, () =>
      Instance.provide({
        directory: localTmpDir,
        fn: () => runEffect(localRuntime, (localTools as any)[step.tool].execute(step.localArgs, localCtx())),
      }),
    )
    localTimes.push(localMs)

    const sandboxMs = await time(`sandbox:${step.name}`, () =>
      Instance.provide({
        directory: process.cwd(),
        fn: () => runEffect(sandboxRuntime, (sandboxTools as any)[step.tool].execute(step.sandboxArgs, sandboxCtx(sb))),
      }),
    )
    sandboxTimes.push(sandboxMs)
  }

  results.push({ step: step.name, localMs: localTimes, sandboxMs: sandboxTimes })
}

// ── Output Table ──

function avg(arr: number[]) { return arr.reduce((a, b) => a + b, 0) / arr.length }
function min(arr: number[]) { return Math.min(...arr) }
function max(arr: number[]) { return Math.max(...arr) }
function fmt(ms: number) { return ms.toFixed(1).padStart(8) + "ms" }

console.log()
console.log("┌─────────────────────────┬────────────────────────────┬────────────────────────────┬──────────┐")
console.log("│ Step                    │ Local (avg / min / max)    │ Sandbox (avg / min / max)  │ Ratio    │")
console.log("├─────────────────────────┼────────────────────────────┼────────────────────────────┼──────────┤")

for (const r of results) {
  const la = avg(r.localMs), lmin = min(r.localMs), lmax = max(r.localMs)
  const sa = avg(r.sandboxMs), smin = min(r.sandboxMs), smax = max(r.sandboxMs)
  const ratio = sa / la
  const ratioStr = ratio > 1 ? `${ratio.toFixed(1)}x ↑` : `${(1/ratio).toFixed(1)}x ↓`

  console.log(
    `│ ${r.step.padEnd(24)}│ ${fmt(la)} / ${fmt(lmin)} / ${fmt(lmax)} │ ${fmt(sa)} / ${fmt(smin)} / ${fmt(smax)} │ ${ratioStr.padStart(8)} │`,
  )
}

console.log("└─────────────────────────┴────────────────────────────┴────────────────────────────┴──────────┘")
console.log()

// Summary
const totalLocal = results.reduce((sum, r) => sum + avg(r.localMs), 0)
const totalSandbox = results.reduce((sum, r) => sum + avg(r.sandboxMs), 0)
console.log(`Total avg:  Local = ${totalLocal.toFixed(1)}ms  |  Sandbox = ${totalSandbox.toFixed(1)}ms  |  Ratio = ${(totalSandbox / totalLocal).toFixed(2)}x`)
console.log()

// Cleanup
fs.rmSync(localTmpDir, { recursive: true, force: true })
await sb.kill().catch(() => {})
await sb.close().catch(() => {})
await localRuntime.dispose()
await sandboxRuntime.dispose()
