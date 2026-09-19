import { describe, expect, test } from "bun:test"
import { SandboxOOM } from "@opencode/core/sandbox-oom"

describe("parseOomSample", () => {
  test("parses cgroup v2 output", () => {
    expect(
      SandboxOOM.parseOomSample("OOM=3\nUSAGE=1048576\nLIMIT=268435456\n"),
    ).toEqual({ oom: 3, usage: 1048576, limit: 268435456 })
  })
  test("parses cgroup v1 output", () => {
    expect(SandboxOOM.parseOomSample("OOM=0\nUSAGE=1000\nLIMIT=2000\n")).toEqual({ oom: 0, usage: 1000, limit: 2000 })
  })
  test("missing metrics stay null", () => {
    expect(SandboxOOM.parseOomSample("USAGE=10\n")).toEqual({ oom: null, usage: 10, limit: null })
  })
  test("empty output is all null", () => {
    expect(SandboxOOM.parseOomSample("")).toEqual({ oom: null, usage: null, limit: null })
  })
  test("v2 unlimited limit parses as huge number", () => {
    expect(SandboxOOM.parseOomSample("OOM=0\nUSAGE=10\nLIMIT=9007199254740992\n").limit).toBe(9007199254740992)
  })
})

describe("classifyOomSample", () => {
  const sample = (oom: number | null, usage: number | null = null, limit: number | null = null) => ({ oom, usage, limit })

  test("null oom is silent", () => {
    expect(SandboxOOM.classifyOomSample({ sample: sample(null), previous: undefined, pressureWindowKey: -1 })).toEqual({ action: "silent" })
  })
  test("first sighting only sets the baseline", () => {
    expect(SandboxOOM.classifyOomSample({ sample: sample(6), previous: undefined, pressureWindowKey: -1 })).toEqual({ action: "baseline" })
  })
  test("negative delta (sandbox rebuilt) silently resets", () => {
    expect(SandboxOOM.classifyOomSample({ sample: sample(0), previous: 6, pressureWindowKey: -1 })).toEqual({ action: "baseline" })
  })
  test("positive delta reports the OOM with totals", () => {
    expect(SandboxOOM.classifyOomSample({ sample: sample(7, 1000, 2000), previous: 5, pressureWindowKey: -1 })).toEqual({
      action: "oom",
      delta: 2,
      total: 7,
      usage: 1000,
      limit: 2000,
    })
  })
  test("no delta and low watermark is silent", () => {
    expect(SandboxOOM.classifyOomSample({ sample: sample(5, 100, 2000), previous: 5, pressureWindowKey: -1 })).toEqual({ action: "silent" })
  })
  test("watermark at or above 85% reports pressure", () => {
    expect(SandboxOOM.classifyOomSample({ sample: sample(5, 1800, 2000), previous: 5, pressureWindowKey: -1 })).toEqual({
      action: "pressure",
      pct: 90,
      usage: 1800,
      limit: 2000,
    })
  })
  test("unlimited limit never reports pressure", () => {
    expect(
      SandboxOOM.classifyOomSample({ sample: sample(5, 9007199254740992, 9007199254740992), previous: 5, pressureWindowKey: -1 }),
    ).toEqual({ action: "silent" })
  })
  test("OOM wins over pressure in the same sample", () => {
    const verdict = SandboxOOM.classifyOomSample({ sample: sample(9, 1900, 2000), previous: 5, pressureWindowKey: -1 })
    expect(verdict.action).toBe("oom")
  })
})

describe("SAMPLE_COMMAND", () => {
  // Regression guard: the usage path was once the hybrid /sys/fs/cgroup/memory/memory.current,
  // which exists on neither cgroup version, so USAGE silently stayed null on v2 sandboxes.
  test("v2 paths come first in every fallback chain", () => {
    expect(SandboxOOM.SAMPLE_COMMAND).toContain("cat /sys/fs/cgroup/memory.current 2>/dev/null ||")
    expect(SandboxOOM.SAMPLE_COMMAND).toContain("cat /sys/fs/cgroup/memory.max 2>/dev/null ||")
    expect(SandboxOOM.SAMPLE_COMMAND).toContain("/sys/fs/cgroup/memory.events 2>/dev/null ||")
  })
  test("never probes a hybrid cgroup path", () => {
    expect(SandboxOOM.SAMPLE_COMMAND).not.toContain("/sys/fs/cgroup/memory/memory.current")
    expect(SandboxOOM.SAMPLE_COMMAND).not.toContain("/sys/fs/cgroup/memory/memory.max")
  })
  test("v1 fallbacks use the nested cgroup directory", () => {
    expect(SandboxOOM.SAMPLE_COMMAND).toContain("/sys/fs/cgroup/memory/memory.usage_in_bytes")
    expect(SandboxOOM.SAMPLE_COMMAND).toContain("/sys/fs/cgroup/memory/memory.limit_in_bytes")
    expect(SandboxOOM.SAMPLE_COMMAND).toContain("/sys/fs/cgroup/memory/memory.oom_control")
  })
  test("each metric is prefixed so output parses regardless of shell ordering", () => {
    expect(SandboxOOM.SAMPLE_COMMAND).toContain("printf 'OOM='")
    expect(SandboxOOM.SAMPLE_COMMAND).toContain("printf 'USAGE='")
    expect(SandboxOOM.SAMPLE_COMMAND).toContain("printf 'LIMIT='")
  })
})
