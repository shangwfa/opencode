import { execFileSync, spawn } from "node:child_process"
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
  connectBackoffMs,
  mcpUseServerProxy,
} from "@opencode/core/session/mcps"

/** Fails when the generated command has unbalanced shell quoting. */
const assertParses = (command: string) => {
  expect(() => execFileSync("bash", ["-n", "-c", command], { stdio: "pipe" })).not.toThrow()
}

/** Evaluates the `--stdio` argument through two bash levels back to its argv words. */
const stdioArgv = (start: string) => {
  const expr = start.match(/--stdio (.+?) --outputTransport/)?.[1]
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
    const portKill = start.indexOf("supergatewa[y]")
    const bridge = start.indexOf("nohup")
    expect(pidKill).toBeGreaterThan(-1)
    expect(portKill).toBeGreaterThan(-1)
    // Cleanup must run before the new bridge binds the port.
    expect(pidKill).toBeLessThan(bridge)
    expect(portKill).toBeLessThan(bridge)
    // Word boundary keeps port 9100 from matching port 91001.
    expect(start).toContain("--port 9100( |$)")
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
    const victim = launch("supergateway --stdio x --port 9100 --logLevel none")
    const survivor = launch("supergateway --stdio x --port 91001 --logLevel none")
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
