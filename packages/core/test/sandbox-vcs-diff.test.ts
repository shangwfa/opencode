import { describe, expect, test } from "bun:test"
import { SandboxVcsDiff } from "../src/sandbox/vcs-diff"

const command = (input: Partial<Parameters<typeof SandboxVcsDiff.vcsDiffCommand>[0]> = {}) =>
  SandboxVcsDiff.vcsDiffCommand({
    mode: "working",
    directory: "/workspace",
    ...input,
  })

describe("SandboxVcsDiff.vcsDiffCommand", () => {
  test("emits a heredoc node script that terminates with NODE", () => {
    const script = command()
    expect(script.startsWith("node <<'NODE'\n")).toBe(true)
    expect(script.endsWith("NODE")).toBe(true)
    // The heredoc is quoted, so no shell expansion of script contents happens.
    expect(script.includes("'NODE'")).toBe(true)
  })

  test("injects mode, base, context, and directory as JSON literals", () => {
    const script = command({ mode: "branch", base: "origin/main", context: 5, directory: "/workspace/worktrees/ses_1" })
    expect(script.includes(`const mode = "branch"`)).toBe(true)
    expect(script.includes(`const baseArg = "origin/main"`)).toBe(true)
    expect(script.includes(`const context = 5`)).toBe(true)
    expect(script.includes(`const directory = "/workspace/worktrees/ses_1"`)).toBe(true)
  })

  test("defaults: no base, context 3", () => {
    const script = command()
    expect(script.includes("const baseArg = null")).toBe(true)
    expect(script.includes("const context = 3")).toBe(true)
  })

  test("escapes hostile directory values instead of interpolating shell text", () => {
    const script = command({ directory: '/workspace/x"; rm -rf /' })
    // JSON.stringify keeps the payload inside the quoted heredoc as a JS string.
    expect(script.includes('const directory = "/workspace/x\\"; rm -rf /"')).toBe(true)
    expect(script.includes("'NODE'\nconst directory = /workspace")).toBe(false)
  })

  test("working mode diffs against HEAD with untracked files, committed skips them", () => {
    const working = command({ mode: "working" })
    const committed = command({ mode: "committed" })
    expect(working.includes('if (mode === "working")')).toBe(true)
    expect(working.includes("untracked()")).toBe(true)
    expect(committed.includes("const items = target ? unique([...changed]) : unique([...changed, ...untracked()])")).toBe(true)
  })

  test("branch mode without a resolvable base reports an error object", () => {
    const script = command({ mode: "branch" })
    expect(script.includes('"No review base available"')).toBe(true)
    expect(script.includes("No merge base available for ")).toBe(true)
  })
})
