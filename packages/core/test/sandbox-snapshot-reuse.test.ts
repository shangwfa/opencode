// 快照复用判定（marker/manifest dirty-check）纯函数回归，T25.24 语义。
import { describe, expect, test } from "bun:test"
import {
  SNAPSHOT_MARKER_PATH,
  SNAPSHOT_MANIFEST_PATH,
  isCleanVerdict,
  parseMarkerOutput,
  snapshotDirtyCheckCommand,
  snapshotManifestCommand,
} from "../src/sandbox/snapshot-reuse"

describe("snapshot dirty-check command", () => {
  test("quick path compares mtimes against the marker", () => {
    const command = snapshotDirtyCheckCommand()
    expect(command).toContain(`find /workspace -newermm ${SNAPSHOT_MARKER_PATH} -print -quit`)
    expect(command).toContain(`timeout 10 `)
    expect(command.trim().endsWith("echo CLEAN; else echo DIRTY; fi")).toBe(true)
  })

  test("content manifest falls back when the quick path is clean", () => {
    const command = snapshotDirtyCheckCommand()
    expect(command).toContain(`[ -f ${SNAPSHOT_MANIFEST_PATH} ] || { echo DIRTY; exit 0; }`)
    // 两段 timeout 各自包裹，不用 `timeout N { ...; }` 的错误形态
    expect(command).toContain("timeout 15 find")
    expect(command).toContain("bash -o pipefail")
    expect(command).not.toContain("timeout 10 {")
  })

  test("manifest command writes a sorted mode/size/hash listing", () => {
    const command = snapshotManifestCommand()
    expect(command).toContain("%y %m %s %p %l")
    expect(command).toContain("bash -o pipefail")
    expect(command).toContain("sha256sum")
    expect(command).toContain("LC_ALL=C sort")
    expect(command).toContain(SNAPSHOT_MANIFEST_PATH)
  })
})

describe("clean verdict", () => {
  test("matches CLEAN only as a whole line", () => {
    expect(isCleanVerdict("CLEAN\n")).toBe(true)
    expect(isCleanVerdict("CLEAN")).toBe(true)
    expect(isCleanVerdict("DIRTY\n")).toBe(false)
    expect(isCleanVerdict("")).toBe(false)
    // 错误回显里混入命令源码的字面量不能误判
    expect(isCleanVerdict('sh: echo CLEAN; else echo DIRTY; fi: not found\n')).toBe(false)
  })
})

describe("parseMarkerOutput", () => {
  test("digits line is workspace KB, uname maps to server arch", () => {
    expect(parseMarkerOutput("12345\nx86_64\n")).toEqual({ workspaceKb: 12345, arch: "amd64" })
    expect(parseMarkerOutput("aarch64\n")).toEqual({ workspaceKb: null, arch: "arm64" })
    expect(parseMarkerOutput("42\n")).toEqual({ workspaceKb: 42, arch: null })
  })

  test("empty or garbage output stays null (conservative)", () => {
    expect(parseMarkerOutput("")).toEqual({ workspaceKb: null, arch: null })
    expect(parseMarkerOutput("not-a-number\nweird\n")).toEqual({ workspaceKb: null, arch: null })
  })
})
