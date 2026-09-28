import { execFileSync } from "node:child_process"
import { describe, expect, test } from "bun:test"
import { Mcp } from "@opencode/schema/mcp"
import { bridgeStartCommand, bridgeStopCommand, mcpUseServerProxy } from "@opencode/core/session/mcps"

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
