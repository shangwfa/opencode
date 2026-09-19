import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// The agent entrypoint runs on Node in production; Bun executes the TypeScript
// source directly, so tests exercise the same code without a build step.
const AGENT = join(import.meta.dir, "..", "agent.ts")

const NO_REPLY = Symbol("no-reply")

type Done = {
  ok: boolean
  value?: unknown
  error?: { kind: string; message: string }
  toolCalls: Array<{ name: string }>
  logs?: string[]
  warnings?: Array<{ kind: string }>
}

type Request = { id: number; tool: string; input: unknown }

const runAgent = (options: {
  code?: string
  limits?: Record<string, number>
  tools?: Array<{ path: string; description: string }>
  omitOptions?: boolean
  omitDir?: boolean
  respond?: (request: Request) => unknown | typeof NO_REPLY
}) =>
  new Promise<{ done: Done; stderr: string }>((resolve, reject) => {
    const dir = mkdtempSync(join(tmpdir(), "codemode-agent-test-"))
    if (!options.omitOptions)
      writeFileSync(
        join(dir, "options.json"),
        JSON.stringify({ code: options.code, limits: options.limits, tools: options.tools }),
      )
    const env: Record<string, string | undefined> = { ...process.env }
    if (options.omitDir) delete env["OPENCODE_CODEMODE_DIR"]
    else env["OPENCODE_CODEMODE_DIR"] = dir
    const child = spawn(process.execPath, [AGENT], { env, stdio: ["ignore", "pipe", "pipe"] })
    let buffer = ""
    let stderr = ""
    const finish = (done: Done) => {
      child.kill()
      rmSync(dir, { recursive: true, force: true })
      resolve({ done, stderr })
    }
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString()
      let index
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line.startsWith("@req ")) {
          const request = JSON.parse(line.slice("@req ".length)) as Request
          const outcome = options.respond?.(request)
          if (outcome === NO_REPLY || outcome === undefined) continue
          const temp = join(dir, `resp-${request.id}.tmp`)
          writeFileSync(temp, JSON.stringify(outcome))
          renameSync(temp, join(dir, `resp-${request.id}.json`))
        } else if (line.startsWith("@done ")) {
          finish(JSON.parse(line.slice("@done ".length)) as Done)
        }
      }
    })
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()))
    child.on("exit", (code) => {
      rmSync(dir, { recursive: true, force: true })
      reject(new Error(`agent exited with code ${code} before @done; stderr: ${stderr}`))
    })
  })

describe("codemode agent", () => {
  test("returns the program value and records no tool calls", async () => {
    const { done } = await runAgent({ code: "return 1 + 1", tools: [] })
    expect(done).toEqual({ ok: true, value: 2, toolCalls: [] })
  })

  test("rejects an empty program with a parse diagnostic", async () => {
    const { done } = await runAgent({ code: "   ", tools: [] })
    expect(done.ok).toBe(false)
    expect(done.error?.kind).toBe("ParseError")
  })

  test("reports syntax errors as data instead of crashing", async () => {
    const { done } = await runAgent({ code: "return (", tools: [] })
    expect(done.ok).toBe(false)
    expect(done.error?.kind).toBe("ParseError")
    expect(done.toolCalls).toEqual([])
  })

  test("fails closed when OPENCODE_CODEMODE_DIR is missing", async () => {
    const { done } = await runAgent({ code: "return 1", omitDir: true })
    expect(done.ok).toBe(false)
    expect(done.error?.kind).toBe("ExecutionFailure")
    expect(done.error?.message).toContain("OPENCODE_CODEMODE_DIR")
  })

  test("fails closed when options.json is unreadable", async () => {
    const { done } = await runAgent({ code: "return 1", omitOptions: true })
    expect(done.ok).toBe(false)
    expect(done.error?.kind).toBe("ExecutionFailure")
    expect(done.error?.message).toContain("options")
  })

  test("routes namespaced tool calls over the bridge with the full path", async () => {
    const requests: Array<Request> = []
    const { done } = await runAgent({
      code: `const a = await tools.test.echo({ v: 7 }); return a.v`,
      tools: [{ path: "test.echo", description: "returns its input" }],
      respond: (request) => {
        requests.push(request)
        return { value: request.input }
      },
    })
    expect(requests).toEqual([{ id: 1, tool: "test.echo", input: { v: 7 } }])
    expect(done.ok).toBe(true)
    expect(done.value).toBe(7)
    expect(done.toolCalls).toEqual([{ name: "test.echo" }])
  })

  test("propagates a failed bridge call as a ToolFailure diagnostic", async () => {
    const { done } = await runAgent({
      code: `await tools.test.boom({}); return null`,
      tools: [{ path: "test.boom", description: "always fails" }],
      respond: () => ({ __error: "boom" }),
    })
    expect(done.ok).toBe(false)
    expect(done.error?.kind).toBe("ToolFailure")
    expect(done.error?.message).toBe("boom")
    expect(done.toolCalls).toEqual([{ name: "test.boom" }])
  })

  test("exposes the built-in search over the provided catalog", async () => {
    const { done } = await runAgent({
      code: `const found = await search({ query: "echo" }); return found.items.map((item) => item.path)`,
      tools: [
        { path: "test.echo", description: "echoes a value" },
        { path: "test.other", description: "something else" },
      ],
    })
    expect(done.ok).toBe(true)
    expect(done.value).toEqual(["tools.test.echo"])
  })

  test("collects console output into logs", async () => {
    const { done } = await runAgent({ code: `console.log("hello"); return 1`, tools: [] })
    expect(done.ok).toBe(true)
    expect(done.logs).toEqual(["hello"])
  })

  test("enforces the tool-call limit as a diagnostic", async () => {
    const { done } = await runAgent({
      code: `await tools.test.a({}); await tools.test.a({}); return null`,
      limits: { maxToolCalls: 1 },
      tools: [{ path: "test.a", description: "noop" }],
      respond: () => ({ value: null }),
    })
    expect(done.ok).toBe(false)
    expect(done.error?.kind).toBe("ToolCallLimitExceeded")
  })

  test("interrupts a busy loop at the wall-clock timeout", async () => {
    const { done } = await runAgent({ code: `while (true) {}`, limits: { timeoutMs: 100 }, tools: [] })
    expect(done.ok).toBe(false)
    expect(done.error?.kind).toBe("TimeoutExceeded")
  })
})
