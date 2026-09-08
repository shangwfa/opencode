/**
 * sandbox-proxy 诊断与信号解码单元测试
 *
 * 覆盖 OOM/端口诊断增强（proxy 502 增强体）与信号退出码解码：
 * - signalName / exitSignal：exitCode >= 128 解码为信号名
 * - parseDiag：沙箱诊断命令输出的解析（端口监听 / cgroup OOM / dmesg）
 * - diagHint：面向用户的提示文案生成
 * - diagnosePort：诊断 Effect 的执行、缓存与失败降级
 */
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { exitSignal, signalName, parseDiag, diagHint, diagnosePort } from "../../src/server/sandbox-proxy"
import type { SessionID } from "../../src/session/schema"

const sid = (s: string) => s as SessionID

function fakeSandbox(stdoutByCall: string[], failure?: Error) {
  const calls: Array<{ command: string; timeoutSeconds?: number }> = []
  let index = 0
  const sandbox = {
    runInSession: (_sessionID: string, command: string, options?: { timeoutSeconds?: number }) => {
      calls.push({ command, timeoutSeconds: options?.timeoutSeconds })
      if (failure) return Effect.fail(failure)
      const text = stdoutByCall[index] ?? ""
      index++
      return Effect.succeed({ logs: { stdout: [{ text }], stderr: [] }, exitCode: 0 })
    },
  }
  return { sandbox: sandbox as any, calls }
}

describe("signalName", () => {
  test("maps common signals", () => {
    expect(signalName(9)).toBe("SIGKILL")
    expect(signalName(15)).toBe("SIGTERM")
    expect(signalName(13)).toBe("SIGPIPE")
    expect(signalName(6)).toBe("SIGABRT")
    expect(signalName(1)).toBe("SIGHUP")
  })

  test("falls back to SIG<n> for unknown signals", () => {
    expect(signalName(24)).toBe("SIG24")
    expect(signalName(0)).toBe("SIG0")
  })
})

describe("exitSignal", () => {
  test("returns undefined for non-signal exits", () => {
    expect(exitSignal(undefined)).toBeUndefined()
    expect(exitSignal(null)).toBeUndefined()
    expect(exitSignal(0)).toBeUndefined()
    expect(exitSignal(1)).toBeUndefined()
    expect(exitSignal(127)).toBeUndefined()
  })

  test("decodes 128 + signum", () => {
    expect(exitSignal(129)).toBe("SIGHUP")
    expect(exitSignal(137)).toBe("SIGKILL")
    expect(exitSignal(143)).toBe("SIGTERM")
    expect(exitSignal(200)).toBe("SIG72")
  })
})

describe("parseDiag", () => {
  test("parses a healthy full output", () => {
    const out = [
      "PORT=200",
      "OOM=3",
      "KILLED=[53656276.278075] Memory cgroup out of memory: Killed process 3213136 (MainThread) total-vm:12677632kB",
    ].join("\n")
    const d = parseDiag(out)
    expect(d.portListening).toBe(true)
    expect(d.oomKillCount).toBe(3)
    expect(d.lastKilled).toContain("Killed process 3213136")
  })

  test("PORT=000 means no listener", () => {
    const d = parseDiag("PORT=000\nOOM=\nKILLED=")
    expect(d.portListening).toBe(false)
    expect(d.oomKillCount).toBeNull()
    expect(d.lastKilled).toBeNull()
  })

  test("HTTP error codes still mean the port is listening", () => {
    for (const code of ["404", "500", "502"]) {
      expect(parseDiag(`PORT=${code}\nOOM=\nKILLED=`).portListening).toBe(true)
    }
  })

  test("non-numeric or missing OOM becomes null", () => {
    expect(parseDiag("PORT=000\nOOM=\nKILLED=").oomKillCount).toBeNull()
    expect(parseDiag("PORT=000\nOOM=abc\nKILLED=").oomKillCount).toBeNull()
    expect(parseDiag("PORT=000").oomKillCount).toBeNull()
  })

  test("empty output yields defaults", () => {
    const d = parseDiag("")
    expect(d.portListening).toBe(false)
    expect(d.oomKillCount).toBeNull()
    expect(d.lastKilled).toBeNull()
  })

  test("ignores unrelated noise lines", () => {
    const out = ["some boot log line", "PORT=200", "unrelated=1", "OOM=1", "KILLED=x"].join("\n")
    const d = parseDiag(out)
    expect(d.portListening).toBe(true)
    expect(d.oomKillCount).toBe(1)
    expect(d.lastKilled).toBe("x")
  })
})

describe("diagHint", () => {
  test("mentions OOM when oomKillCount > 0", () => {
    const hint = diagHint({ portListening: false, oomKillCount: 3, lastKilled: null }, 5174)
    expect(hint).toContain("port 5174")
    expect(hint).toContain("memory OOM")
    expect(hint).toContain("oom_kill=3")
  })

  test("mentions OOM when only dmesg evidence exists", () => {
    const hint = diagHint({ portListening: false, oomKillCount: null, lastKilled: "Killed process 1" }, 3000)
    expect(hint).toContain("memory OOM")
  })

  test("falls back to no-listener guidance without OOM evidence", () => {
    const hint = diagHint({ portListening: false, oomKillCount: 0, lastKilled: null }, 5174)
    expect(hint).toContain("no listener")
    expect(hint).not.toContain("OOM")
  })
})

describe("diagnosePort", () => {
  test("runs the diagnostic command and parses output", async () => {
    const { sandbox, calls } = fakeSandbox(["PORT=000\nOOM=2\nKILLED=Killed process 42"])
    const d = await Effect.runPromise(diagnosePort(sandbox, sid("ses_diag_parse"), 5174))
    expect(d).toEqual({ portListening: false, oomKillCount: 2, lastKilled: "Killed process 42" })
    expect(calls.length).toBe(1)
    expect(calls[0].command).toContain("127.0.0.1:5174")
    expect(calls[0].timeoutSeconds).toBe(8)
  })

  test("caches results per session:port within the window", async () => {
    const { sandbox, calls } = fakeSandbox(["PORT=200\nOOM=\nKILLED="])
    const first = await Effect.runPromise(diagnosePort(sandbox, sid("ses_diag_cache"), 5174))
    const second = await Effect.runPromise(diagnosePort(sandbox, sid("ses_diag_cache"), 5174))
    expect(first).toEqual(second)
    expect(calls.length).toBe(1)
  })

  test("different session or port bypasses the cache", async () => {
    const { sandbox, calls } = fakeSandbox(["PORT=200\nOOM=\nKILLED=", "PORT=000\nOOM=\nKILLED="])
    await Effect.runPromise(diagnosePort(sandbox, sid("ses_diag_multi_a"), 5174))
    await Effect.runPromise(diagnosePort(sandbox, sid("ses_diag_multi_b"), 5174))
    await Effect.runPromise(diagnosePort(sandbox, sid("ses_diag_multi_a"), 3000))
    expect(calls.length).toBe(3)
  })

  test("returns undefined when the sandbox command fails", async () => {
    const { sandbox } = fakeSandbox([], new Error("sandbox gone"))
    const d = await Effect.runPromise(diagnosePort(sandbox, sid("ses_diag_fail"), 5174))
    expect(d).toBeUndefined()
  })
})
