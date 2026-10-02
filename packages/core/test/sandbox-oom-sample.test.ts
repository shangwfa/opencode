import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SandboxOomSample } from "../src/sandbox/oom-sample"

const sample = (oomKill: number | null, usageBytes: number | null, limitBytes: number | null) => ({
  oomKill,
  usageBytes,
  limitBytes,
})

describe("parseOomSample", () => {
  test("parses the three keys in order", () => {
    expect(SandboxOomSample.parseOomSample("OOM=2\nUSAGE=1000\nLIMIT=2000\n")).toEqual(
      sample(2, 1000, 2000),
    )
  })

  test("tolerates unordered lines and noise", () => {
    const stdout = ["noise line", "LIMIT=2000", "USAGE=1000", "OOM=0", ""].join("\n")
    expect(SandboxOomSample.parseOomSample(stdout)).toEqual(sample(0, 1000, 2000))
  })

  test("missing keys stay null", () => {
    expect(SandboxOomSample.parseOomSample("USAGE=5\n")).toEqual(sample(null, 5, null))
    expect(SandboxOomSample.parseOomSample("")).toEqual(sample(null, null, null))
  })

  test("streamed chunks without newlines concatenate into one line and still parse", () => {
    // The command-session transport strips newlines between stdout chunks, so
    // the three markers can arrive as a single concatenated run.
    expect(SandboxOomSample.parseOomSample("OOM=0USAGE=9252864LIMIT=4294967296")).toEqual(
      sample(0, 9252864, 4294967296),
    )
  })

  test("first occurrence of a key wins", () => {
    expect(SandboxOomSample.parseOomSample("OOM=1 noise OOM=9 USAGE=5 USAGE=7")).toEqual(sample(1, 5, null))
  })

  test("empty values stay null", () => {
    expect(SandboxOomSample.parseOomSample("OOM=\nUSAGE=\nLIMIT=\n")).toEqual(sample(null, null, null))
  })

  test("non-numeric values stay null", () => {
    expect(SandboxOomSample.parseOomSample("OOM=abc\nUSAGE=12x\nLIMIT=1.5.5\n")).toEqual(sample(null, null, null))
  })

  test("keeps raw numbers for huge v1 sentinel limits", () => {
    const huge = "9223372036854771712"
    expect(SandboxOomSample.parseOomSample(`OOM=0\nUSAGE=10\nLIMIT=${huge}\n`)).toEqual(sample(0, 10, Number(huge)))
  })

  test("command stays cgroup v1/v2 compatible with per-file fallbacks", () => {
    const command = SandboxOomSample.OOM_SAMPLE_COMMAND
    expect(command).toContain("memory.events")
    expect(command).toContain("memory.oom_control")
    expect(command).toContain("|| awk")
    expect(command).toContain("|| cat")
    // busybox awk reads only the first file, so no single awk may take both paths
    expect(command).not.toMatch(/awk[^|\n]*\/sys\/fs\/cgroup\/[^\s]+\s+\/sys\/fs\/cgroup\//)
    expect(command).not.toMatch(/cat \/sys\/fs\/cgroup\/[^\s]+\s+\/sys\/fs\/cgroup\//)
  })
})

describe("classifyOomSample", () => {
  const input = (prev: ReturnType<typeof sample> | undefined, s: ReturnType<typeof sample>) => ({
    sessionID: "ses_test",
    sandboxID: "sb_test",
    prev,
    sample: s,
    now: 1_000_000,
  })

  test("first round only establishes the baseline", () => {
    expect(SandboxOomSample.classifyOomSample(input(undefined, sample(5, 100, 200)))).toEqual({ kind: "none" })
  })

  test("positive delta is an oom attribution", () => {
    const result = SandboxOomSample.classifyOomSample(input(sample(2, 100, 200), sample(4, 150, 200)))
    expect(result).toEqual({
      kind: "oom",
      oomKillDelta: 2,
      oomKillTotal: 4,
      usageBytes: 150,
      limitBytes: 200,
    })
  })

  test("negative delta (rebuilt sandbox) silently resets", () => {
    expect(SandboxOomSample.classifyOomSample(input(sample(5, 100, 200), sample(0, 10, 200)))).toEqual({
      kind: "none",
    })
  })

  test("usage at or above the ratio is pressure", () => {
    const result = SandboxOomSample.classifyOomSample(input(sample(0, 170, 200), sample(0, 170, 200)))
    expect(result).toEqual({ kind: "pressure", pct: 85, usageBytes: 170, limitBytes: 200 })
  })

  test("pressure below the ratio is none", () => {
    expect(SandboxOomSample.classifyOomSample(input(sample(0, 168, 200), sample(0, 169, 200)))).toEqual({
      kind: "none",
    })
  })

  test("oom wins over pressure", () => {
    const result = SandboxOomSample.classifyOomSample(input(sample(0, 190, 200), sample(1, 190, 200)))
    expect(result.kind).toBe("oom")
  })

  test("unlimited or invalid limits never report pressure", () => {
    const huge = 2 ** 52
    expect(SandboxOomSample.classifyOomSample(input(sample(0, huge, huge), sample(0, huge, huge)))).toEqual({
      kind: "none",
    })
    expect(SandboxOomSample.classifyOomSample(input(sample(0, 10, 0), sample(0, 10, 0)))).toEqual({ kind: "none" })
    expect(SandboxOomSample.classifyOomSample(input(sample(0, null, 100), sample(0, null, 100)))).toEqual({
      kind: "none",
    })
  })

  test("all-null samples are none", () => {
    expect(SandboxOomSample.classifyOomSample(input(sample(null, null, null), sample(null, null, null)))).toEqual({
      kind: "none",
    })
  })

  test("custom pressure ratio is honored", () => {
    const base = input(sample(0, 60, 100), sample(0, 60, 100))
    expect(SandboxOomSample.classifyOomSample({ ...base, pressureRatio: 0.5 })).toMatchObject({ kind: "pressure" })
    expect(SandboxOomSample.classifyOomSample({ ...base, pressureRatio: 0.7 })).toEqual({ kind: "none" })
  })
})

describe("sampleSandbox", () => {
  test("runs the command in a throwaway session and deletes it afterwards", async () => {
    const created: string[] = []
    const deleted: string[] = []
    const commands = {
      createSession: async () => {
        const id = `cmd-${created.length + 1}`
        created.push(id)
        return id
      },
      deleteSession: async (id: string) => {
        deleted.push(id)
      },
      runInSessionStream: async function* (sessionId: string) {
        expect(created).toContain(sessionId)
        yield { type: "stdout", text: "OOM=1\nUSAGE=10\nLIMIT=20\n" }
      },
    }
    const result = await Effect.runPromise(SandboxOomSample.sampleSandbox(commands as never))
    expect(result).toEqual(sample(1, 10, 20))
    expect(deleted).toEqual(created)
  })

  test("session is deleted even when the command stream fails", async () => {
    const deleted: string[] = []
    const commands = {
      createSession: async () => "cmd-fail",
      deleteSession: async (id: string) => {
        deleted.push(id)
      },
      runInSessionStream: async function* () {
        throw new Error("context not found")
      },
    }
    const outcome = await Effect.runPromise(
      SandboxOomSample.sampleSandbox(commands as never).pipe(Effect.flip),
    ).catch((error) => error)
    expect(String(outcome)).toContain("context not found")
    expect(deleted).toEqual(["cmd-fail"])
  })
})
