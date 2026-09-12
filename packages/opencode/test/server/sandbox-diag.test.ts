/**
 * sandbox-proxy 诊断与信号解码单元测试
 *
 * 覆盖 OOM/端口诊断增强（proxy 502 增强体）与信号退出码解码：
 * - signalName / exitSignal：exitCode >= 128 解码为信号名
 * - parseDiag：沙箱诊断命令输出的解析（端口监听 / cgroup OOM / dmesg）
 * - diagHint：面向用户的提示文案生成
 * - diagnosePort：诊断 Effect 的执行、缓存与失败降级
 * - parseOomSample：watchdog OOM 采样命令输出的解析（cgroup v1/v2 双格式）
 */
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { exitSignal, signalName, parseDiag, diagHint, diagnosePort } from "../../src/server/sandbox-proxy"
import { OOM_SAMPLE_COMMAND, classifyOomSample, parseOomSample } from "../../src/tool/sandbox-provider"
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

describe("parseOomSample", () => {
  test("parses cgroup v2 output", () => {
    expect(parseOomSample("OOM=3\nUSAGE=1073741824\nLIMIT=2147483648")).toEqual({
      oomKill: 3,
      usageBytes: 1073741824,
      limitBytes: 2147483648,
    })
  })

  test("parses cgroup v1 output with near-2^63 unlimited limit", () => {
    const sample = parseOomSample("OOM=1\nUSAGE=536870912\nLIMIT=9223372036854771712")
    expect(sample.oomKill).toBe(1)
    expect(sample.usageBytes).toBe(536870912)
    // 解析层保留原值，「无限制」判定（>1e15 视为未设限）由调用方负责
    expect(sample.limitBytes).toBe(9223372036854771712)
  })

  test("v2 unlimited limit ('max') becomes null", () => {
    expect(parseOomSample("OOM=0\nUSAGE=123\nLIMIT=max").limitBytes).toBeNull()
  })

  test("empty output yields all nulls", () => {
    expect(parseOomSample("")).toEqual({ oomKill: null, usageBytes: null, limitBytes: null })
  })

  test("ignores unrelated noise lines and tolerates reordering", () => {
    const sample = parseOomSample("some echo junk\nLIMIT=2147483648\nOOM=2\nUSAGE=99\n")
    expect(sample).toEqual({ oomKill: 2, usageBytes: 99, limitBytes: 2147483648 })
  })

  test("missing USAGE becomes null while others parse", () => {
    expect(parseOomSample("OOM=4\nLIMIT=1024")).toEqual({ oomKill: 4, usageBytes: null, limitBytes: 1024 })
  })

  test("sample command only emits the OOM/USAGE/LIMIT keys", () => {
    for (const key of ["OOM=", "USAGE=", "LIMIT="]) expect(OOM_SAMPLE_COMMAND).toContain(`'${key}'`)
  })

  test("sample command avoids multi-file awk (busybox exits on first missing file)", () => {
    // v1 沙箱没有 memory.events：busybox awk 收到多文件参数时第一个文件打不开就直接退出
    //（2>/dev/null 吞掉报错），永远轮不到 v1 路径——必须用 `||` 链逐文件探测
    expect(OOM_SAMPLE_COMMAND).toContain("|| awk")
    expect(OOM_SAMPLE_COMMAND).not.toMatch(/awk[^|;]*\/sys\/fs\/cgroup\/memory\.events[^|;]*\/sys\/fs\/cgroup\/memory\.oom_control/)
  })
})

describe("classifyOomSample", () => {
  const sample = (over: Partial<Parameters<typeof classifyOomSample>[0]["sample"]>) => ({
    oomKill: null,
    usageBytes: null,
    limitBytes: null,
    ...over,
  })
  const input = (over: Partial<Parameters<typeof classifyOomSample>[0]>) => ({
    sessionID: "ses_oom",
    sandboxID: "sbx_oom",
    prev: undefined,
    sample: sample({}),
    now: 1_000_000_000_000,
    ...over,
  })

  test("first round (no baseline) never alerts even with oomKill > 0", () => {
    const a = classifyOomSample(input({ sample: sample({ oomKill: 5 }) }))
    expect(a.kind).toBe("none")
  })

  test("delta > 0 produces an oom action with idempotent id and structured error", () => {
    const a = classifyOomSample(input({ prev: 5, sample: sample({ oomKill: 7, usageBytes: 100, limitBytes: 200 }) }))
    expect(a.kind).toBe("oom")
    if (a.kind !== "oom") return
    expect(a.id).toBe("oom-ses_oom-sbx_oom-7")
    expect(a.delta).toBe(2)
    expect(a.oomKillTotal).toBe(7)
    expect(a.command).toContain("delta=2")
    const err = JSON.parse(a.error)
    expect(err).toMatchObject({ name: "SandboxOOM", oomKillDelta: 2, oomKillTotal: 7 })
  })

  test("oom id deduplicates per oom_kill total but differs across totals", () => {
    const a1 = classifyOomSample(input({ prev: 0, sample: sample({ oomKill: 3 }) }))
    const a2 = classifyOomSample(input({ prev: 0, sample: sample({ oomKill: 3 }) }))
    const a3 = classifyOomSample(input({ prev: 0, sample: sample({ oomKill: 4 }) }))
    if (a1.kind !== "oom" || a2.kind !== "oom" || a3.kind !== "oom") throw new Error("expected oom actions")
    expect(a1.id).toBe(a2.id)
    expect(a1.id).not.toBe(a3.id)
  })

  test("same total across sandbox generations gets distinct ids (no cross-generation swallow)", () => {
    const oldGen = classifyOomSample(input({ prev: 0, sample: sample({ oomKill: 1 }), sandboxID: "sbx_old" }))
    const newGen = classifyOomSample(input({ prev: 0, sample: sample({ oomKill: 1 }), sandboxID: "sbx_new" }))
    if (oldGen.kind !== "oom" || newGen.kind !== "oom") throw new Error("expected oom actions")
    expect(oldGen.id).not.toBe(newGen.id)
    // 跨实例同沙箱同 total 仍幂等
    const dup = classifyOomSample(input({ prev: 0, sample: sample({ oomKill: 1 }), sandboxID: "sbx_old" }))
    if (dup.kind !== "oom") throw new Error("expected oom action")
    expect(oldGen.id).toBe(dup.id)
  })

  test("negative delta (sandbox rebuilt, counter reset) is silent", () => {
    expect(classifyOomSample(input({ prev: 9, sample: sample({ oomKill: 1 }) })).kind).toBe("none")
  })

  test("pressure fires at exactly 85% and reports rounded pct", () => {
    const a = classifyOomSample(input({ sample: sample({ usageBytes: 850, limitBytes: 1000 }) }))
    expect(a.kind).toBe("pressure")
    if (a.kind !== "pressure") return
    expect(a.pct).toBe(85)
    expect(a.command).toBe("memory-pressure pct=85%")
    expect(JSON.parse(a.error)).toMatchObject({ name: "MemoryPressure", usageBytes: 850, limitBytes: 1000, pct: 0.85 })
  })

  test("below threshold is silent", () => {
    expect(classifyOomSample(input({ sample: sample({ usageBytes: 849, limitBytes: 1000 }) })).kind).toBe("none")
  })

  test("unlimited cgroups never alert on pressure", () => {
    // v1：接近 2^63 的巨大 limit；v2："max" 解析为 null
    expect(classifyOomSample(input({ sample: sample({ usageBytes: 100, limitBytes: 9223372036854771712 }) })).kind).toBe("none")
    expect(classifyOomSample(input({ sample: sample({ usageBytes: 100, limitBytes: null }) })).kind).toBe("none")
  })

  test("missing usage or non-positive limit is silent", () => {
    expect(classifyOomSample(input({ sample: sample({ usageBytes: null, limitBytes: 1000 }) })).kind).toBe("none")
    expect(classifyOomSample(input({ sample: sample({ usageBytes: 100, limitBytes: 0 }) })).kind).toBe("none")
  })

  test("oom takes precedence over pressure", () => {
    const a = classifyOomSample(input({ prev: 0, sample: sample({ oomKill: 1, usageBytes: 990, limitBytes: 1000 }) }))
    expect(a.kind).toBe("oom")
  })

  test("pressure id deduplicates within the 5-minute window, differs across windows", () => {
    const WINDOW = 5 * 60_000
    const base = 1_700_000_000_000
    const bucketStart = Math.floor(base / WINDOW) * WINDOW // base 所在桶的起点
    const sameWindow = bucketStart + WINDOW - 1 // 同桶最后一毫秒
    const nextWindow = bucketStart + WINDOW // 下一桶第一毫秒
    const a = classifyOomSample(input({ now: base, sample: sample({ usageBytes: 900, limitBytes: 1000 }) }))
    const b = classifyOomSample(input({ now: sameWindow, sample: sample({ usageBytes: 900, limitBytes: 1000 }) }))
    const c = classifyOomSample(input({ now: nextWindow, sample: sample({ usageBytes: 900, limitBytes: 1000 }) }))
    if (a.kind !== "pressure" || b.kind !== "pressure" || c.kind !== "pressure") throw new Error("expected pressure actions")
    expect(a.id).toBe(b.id)
    expect(a.id).not.toBe(c.id)
  })

  test("unparseable sample (all null) is silent", () => {
    expect(classifyOomSample(input({ prev: 3, sample: sample({}) })).kind).toBe("none")
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
