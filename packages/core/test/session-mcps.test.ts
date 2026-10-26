import { execFileSync, spawn } from "node:child_process"
import { createServer } from "node:net"
import { createServer as createHttpServer } from "node:http"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Mcp } from "@opencode/schema/mcp"
import {
  BRIDGE_RETRY_BASE_MS,
  BRIDGE_RETRY_BUDGET_MS,
  BRIDGE_RETRY_MAX_MS,
  CONNECT_BACKOFF_MAX_MS,
  RECONCILE_BUDGET_MS,
  bridgeRetryDelay,
  bridgeStartCommand,
  bridgeStopCommand,
  bridgeSweepCommand,
  canReplayCall,
  connectBackoffMs,
  mcpUseServerProxy,
} from "@opencode/core/session/mcps"
import { McpHttpBridge } from "@opencode/core/session/mcp-http-bridge"
import { McpClient } from "@opencode/core/mcp/client"

test("replays only explicit session rejection, never ambiguous dispatch failures", () => {
  expect(canReplayCall(new McpClient.SessionExpiredError({ server: "test", rejected: true }))).toBe(true)
  expect(canReplayCall(new McpClient.SessionExpiredError({ server: "test" }))).toBe(false)
  for (const message of ["Connection closed", "ECONNRESET", "fetch failed", "socket hang up", "HTTP 500", "Request timed out"]) {
    expect(canReplayCall(new Error(message))).toBe(false)
  }
})

test("bridge preflight separates readiness, confirmed death, and unknown health without dispatching", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-health-"))
  const base = join(directory, "test")
  let status = 200
  const requests: string[] = []
  const server = createHttpServer((request, response) => {
    requests.push(`${request.method} ${request.url}`)
    response.writeHead(status).end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("health fixture failed to listen")
  const probe = () => Bun.spawn(["bash", "-c", McpHttpBridge.healthCommand(base, address.port)], { stdout: "ignore", stderr: "ignore" }).exited
  try {
    expect(await probe()).toBe(1)
    await writeFile(`${base}.pid`, String(process.pid))
    expect(await probe()).toBe(0)
    status = 503
    expect(await probe()).toBe(1)
    status = 500
    expect(await probe()).toBe(2)
    await writeFile(`${base}.pid`, "invalid")
    expect(await probe()).toBe(2)
    expect(requests).toEqual(["GET /health", "GET /health", "GET /health"])
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})

/** Fails when the generated command has unbalanced shell quoting. */
const assertParses = (command: string) => {
  expect(() => execFileSync("bash", ["-n", "-c", command], { stdio: "pipe" })).not.toThrow()
}

/** Evaluates the `--stdio` argument through two bash levels back to its argv words. */
const stdioArgv = (start: string) => {
  const expr = start.match(/--stdio (.+?) --port/)?.[1]
  expect(expr).toBeDefined()
  const inner = execFileSync("bash", ["-c", `printf %s ${expr}`], { encoding: "utf8" })
  return execFileSync("bash", ["-c", `set -- ${inner}; printf '%s\\0' "$@"`], { encoding: "utf8", maxBuffer: 1 << 20 })
    .split("\0")
    .filter((word) => word !== "")
}

describe("SessionMcps bridge commands", () => {
  test("quotes commands and environments with embedded metacharacters", () => {
    const config = Mcp.LocalConfig.make({
      type: "local",
      command: ["sh", "-lc", `printf "$MCP_ENV_TEST" >/tmp/x && echo 'a b; touch /tmp/pwned; #'"'"`],
      environment: {
        MCP_ENV_TEST: "hello-env-value",
        "BAD-ENV;touch /tmp/pwned": "x ' quote",
        SAFE_VALUE: "a b c ' quote",
      },
    })
    const start = bridgeStartCommand("safe_name", config, 9100)
    const stop = bridgeStopCommand("safe_name", 9100)
    assertParses(start)
    assertParses(stop)
    // Metacharacters stay inside quoted spans instead of becoming shell syntax.
    expect(start).toContain("'BAD-ENV;touch /tmp/pwned'=")
    expect(start).toContain("/tmp/opencode-mcp/safe_name-9100.pid")
    expect(stop).toContain("/tmp/opencode-mcp/safe_name-9100.log")
  })

  test("round-trips a command containing single quotes through bash", () => {
    const command = ["echo", "it's", "a b; touch /tmp/pwned; #"]
    const start = bridgeStartCommand("q", Mcp.LocalConfig.make({ type: "local", command }), 9101)
    assertParses(start)
    expect(stdioArgv(start)).toEqual(command)
  })

  test("sweep kills every pid file, removes them, and pkill cannot match the sweeping shell", () => {
    const sweep = bridgeSweepCommand()
    assertParses(sweep)
    expect(sweep).toContain('for pidfile in /tmp/opencode-mcp/*.pid')
    expect(sweep).toContain('rm -f /tmp/opencode-mcp/*.pid')
    // Character class keeps the pattern from matching its own command line.
    expect(sweep).toContain("supergatewa[y].*--stdio")
    expect(sweep).not.toMatch(/pkill -f 'supergateway/)
  })
})

describe("SessionMcps stale bridge cleanup", () => {
  const config = Mcp.LocalConfig.make({ type: "local", command: ["echo", "server"] })

  test("start command clears the stale pid file and port holder before starting the bridge", () => {
    const start = bridgeStartCommand("stale", config, 9100)
    assertParses(start)
    const pidKill = start.indexOf('"$(cat \'/tmp/opencode-mcp/stale-9100.pid\')"')
    const portKill = start.indexOf("mcp-http-bridg[e]")
    const bridge = start.indexOf("nohup")
    expect(pidKill).toBeGreaterThan(-1)
    expect(portKill).toBeGreaterThan(-1)
    // Cleanup must run before the new bridge binds the port.
    expect(pidKill).toBeLessThan(bridge)
    expect(portKill).toBeLessThan(bridge)
    // Word boundary keeps port 9100 from matching port 91001.
    expect(start).toContain("--port 9100( |$)")
    // Snapshot-restored workspaces may still carry the old supergateway bridge.
    expect(start).toContain("supergatewa[y].*--port 9100( |$)")
  })

  test("the launcher survives its own stale pkill on images that ship procps", async () => {
    const name = `selfmatch_${Date.now()}`
    const port = 19231
    const pidFile = `/tmp/opencode-mcp/${name}-${port}.pid`
    const logFile = `/tmp/opencode-mcp/${name}-${port}.log`
    await rm(pidFile, { force: true })
    const start = bridgeStartCommand(name, config, port)
    // The launcher's own argv contains `mcp-http-bridge … --port 19231`; if the
    // stale pkill matched it, bash would die with SIGTERM (143) before writing
    // the pid file. A clean exit proves the pattern cannot self-match.
    const result = execFileSync("bash", ["-c", start], { encoding: "utf8", stdio: "pipe" })
    expect(result).toBeDefined()
    const pid = await readFile(pidFile, "utf8").then((value) => Number(value.trim())).catch(() => undefined)
    expect(pid).toBeGreaterThan(0)
    // The bridge binary itself is materialized inside the workspace only on a real
    // sandbox, so the spawned node process may exit here; the launcher must not.
    await rm(pidFile, { force: true })
    await rm(logFile, { force: true })
  })

  test("port pkill kills only the bridge holding the exact port", async () => {
    const start = bridgeStartCommand("stale", config, 9100)
    const pattern = start.match(/pkill -f ('.*?')/)?.[1]
    expect(pattern).toBeDefined()
    const alive = (pid: number | undefined) => {
      try {
        process.kill(pid!, 0)
        return true
      } catch {
        return false
      }
    }
    const launch = (argv0: string) => {
      const child = spawn("bash", ["-c", `exec -a '${argv0}' sleep 5`], { detached: true, stdio: "ignore" })
      child.unref()
      return child.pid
    }
    const victim = launch("mcp-http-bridge.mjs --stdio x --port 9100")
    const survivor = launch("mcp-http-bridge.mjs --stdio x --port 91001")
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(alive(victim)).toBe(true)
    expect(alive(survivor)).toBe(true)
    execFileSync("bash", ["-c", `pkill -f ${pattern} || true`])
    // The victim dies from SIGTERM; the longer-port process stays alive.
    for (let i = 0; i < 20 && alive(victim); i++) await new Promise((resolve) => setTimeout(resolve, 100))
    expect(alive(victim)).toBe(false)
    expect(alive(survivor)).toBe(true)
    process.kill(survivor!, "SIGKILL")
  })
})

describe("MCP HTTP bridge", () => {
  test("bridges a stdio MCP server over streamable HTTP with a client-supplied session id", async () => {
    const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client")
    const directory = await mkdtemp(join(tmpdir(), "mcp-http-bridge-"))
    const bridge = join(directory, "mcp-http-bridge.mjs")
    await writeFile(bridge, McpHttpBridge.script)
    const fixture = join(import.meta.dir, "fixture/mcp-prompts.ts")
    const probe = createServer()
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()))
    const port = (probe.address() as { port: number }).port
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    const child = spawn(process.execPath, [bridge, "--stdio", `${process.execPath} ${fixture}`, "--port", String(port)], {
      stdio: ["ignore", "pipe", "pipe"],
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("bridge did not start")), 10_000)
        child.stdout.on("data", (chunk) => {
          if (String(chunk).includes("mcp-http-bridge:")) {
            clearTimeout(timer)
            resolve()
          }
        })
        child.stderr.on("data", (chunk) => process.stderr.write(chunk))
      })
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`))
      const client = new Client({ name: "bridge-test", version: "1" }, { supportedProtocolVersions: ["2025-06-18", "2025-11-25", "2025-03-26", "2024-11-05"] })
      await client.connect(transport)
      const prompts = await client.listPrompts()
      expect(prompts.prompts.map((prompt) => prompt.name)).toContain("first")
    } finally {
      child.kill()
      await rm(directory, { recursive: true, force: true })
    }
  }, 20_000)
})

describe("SessionMcps connect retry cadence", () => {
  test("backs off exponentially and caps at the V1-verified ceiling", () => {
    expect(bridgeRetryDelay(0)).toBe(BRIDGE_RETRY_BASE_MS)
    expect(bridgeRetryDelay(1)).toBe(500)
    expect(bridgeRetryDelay(2)).toBe(1000)
    expect(bridgeRetryDelay(3)).toBe(BRIDGE_RETRY_MAX_MS)
    expect(bridgeRetryDelay(10)).toBe(BRIDGE_RETRY_MAX_MS)
  })

  test("single-server budget covers at least V1's 30 attempts", () => {
    let total = 0
    let attempts = 0
    while (total <= BRIDGE_RETRY_BUDGET_MS) {
      total += bridgeRetryDelay(attempts)
      attempts += 1
    }
    expect(attempts).toBeGreaterThanOrEqual(30)
  })

  test("reconcile budget stays below the single-server budget it clamps", () => {
    // The soft gate clamps each connect to min(remaining, BRIDGE_RETRY_BUDGET_MS); keeping the
    // reconcile budget smaller preserves the V1 gate semantics (a pass never waits > gate).
    expect(RECONCILE_BUDGET_MS).toBeLessThanOrEqual(BRIDGE_RETRY_BUDGET_MS)
  })
})

describe("SessionMcps connect failure backoff", () => {
  test("backs off exponentially and caps at five minutes", () => {
    expect(connectBackoffMs(1)).toBe(30_000)
    expect(connectBackoffMs(2)).toBe(60_000)
    expect(connectBackoffMs(3)).toBe(120_000)
    expect(connectBackoffMs(4)).toBe(240_000)
    expect(connectBackoffMs(5)).toBe(CONNECT_BACKOFF_MAX_MS)
    expect(connectBackoffMs(9)).toBe(CONNECT_BACKOFF_MAX_MS)
  })

  test("first backoff covers a full reconcile budget", () => {
    // The retry lands at least one full budget window after the failure, so a backed-off
    // server never shares a pass with the budget it already burned.
    expect(connectBackoffMs(1)).toBeGreaterThanOrEqual(RECONCILE_BUDGET_MS)
  })
})

describe("SessionMcps MCP endpoint mode", () => {
  test("covers the A/B/C deployment matrix and the full-gateway fallback", () => {
    // A: pure direct — both flags off.
    expect(mcpUseServerProxy({ useServerProxy: false, mcpServerProxy: false })).toBe(false)
    // B: MCP-only gateway — the switch's independent value.
    expect(mcpUseServerProxy({ useServerProxy: false, mcpServerProxy: true })).toBe(true)
    // C: full gateway — the global flag wins even when the MCP flag is off.
    expect(mcpUseServerProxy({ useServerProxy: true, mcpServerProxy: false })).toBe(true)
    expect(mcpUseServerProxy({ useServerProxy: true, mcpServerProxy: true })).toBe(true)
    // Unset MCP flag parses to true, so the default stays on the gateway path.
    expect(mcpUseServerProxy({ useServerProxy: false, mcpServerProxy: true })).toBe(true)
  })
})
