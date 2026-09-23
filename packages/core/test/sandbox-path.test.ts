import { describe, expect, it } from "bun:test"
import { SandboxPath } from "@opencode/core/sandbox/path"

const WORKDIR = "/Users/dev/project"

describe("SandboxPath.toSandboxPath", () => {
  it("maps the host workdir root", () => {
    expect(SandboxPath.toSandboxPath(WORKDIR, WORKDIR)).toBe("/workspace")
    expect(SandboxPath.toSandboxPath(`${WORKDIR}/`, WORKDIR)).toBe("/workspace/")
  })

  it("maps nested host paths under the workdir", () => {
    expect(SandboxPath.toSandboxPath(`${WORKDIR}/src/index.ts`, WORKDIR)).toBe("/workspace/src/index.ts")
    expect(SandboxPath.toSandboxPath(`${WORKDIR}/a/b/c`, WORKDIR)).toBe("/workspace/a/b/c")
  })

  it("maps relative paths against the sandbox workdir", () => {
    expect(SandboxPath.toSandboxPath(".", WORKDIR)).toBe("/workspace")
    expect(SandboxPath.toSandboxPath("./", WORKDIR)).toBe("/workspace/")
    expect(SandboxPath.toSandboxPath("src/main.ts", WORKDIR)).toBe("/workspace/src/main.ts")
    expect(SandboxPath.toSandboxPath("./src/main.ts", WORKDIR)).toBe("/workspace/src/main.ts")
  })

  it("keeps sandbox paths and foreign absolute paths unchanged", () => {
    expect(SandboxPath.toSandboxPath("/workspace/pkg", WORKDIR)).toBe("/workspace/pkg")
    expect(SandboxPath.toSandboxPath("/etc/hostname", WORKDIR)).toBe("/etc/hostname")
  })
})

describe("SandboxPath.toHostPath", () => {
  it("maps the sandbox root back to the host workdir", () => {
    expect(SandboxPath.toHostPath("/workspace", WORKDIR)).toBe(WORKDIR)
    expect(SandboxPath.toHostPath("/workspace/src/index.ts", WORKDIR)).toBe(`${WORKDIR}/src/index.ts`)
  })

  it("keeps non-sandbox paths unchanged", () => {
    expect(SandboxPath.toHostPath("/etc/hostname", WORKDIR)).toBe("/etc/hostname")
    expect(SandboxPath.toHostPath("", WORKDIR)).toBe(WORKDIR)
  })

  it("returns sandbox paths untouched when the host workdir is already a sandbox path", () => {
    expect(SandboxPath.toHostPath("/workspace/x", "/workspace")).toBe("/workspace/x")
  })
})

describe("SandboxPath.isSandboxPath", () => {
  it("accepts the root and children only", () => {
    expect(SandboxPath.isSandboxPath("/workspace")).toBe(true)
    expect(SandboxPath.isSandboxPath("/workspace/a/b")).toBe(true)
    expect(SandboxPath.isSandboxPath("/workspace-other")).toBe(false)
    expect(SandboxPath.isSandboxPath("/etc")).toBe(false)
    expect(SandboxPath.isSandboxPath("")).toBe(false)
  })
})

describe("SandboxPath.toSandboxCwd", () => {
  it("defaults to the sandbox workdir", () => {
    expect(SandboxPath.toSandboxCwd(undefined, WORKDIR)).toBe("/workspace")
    expect(SandboxPath.toSandboxCwd("", WORKDIR)).toBe("/workspace")
  })

  it("maps host cwd values", () => {
    expect(SandboxPath.toSandboxCwd(WORKDIR, WORKDIR)).toBe("/workspace")
    expect(SandboxPath.toSandboxCwd(`${WORKDIR}/pkg`, WORKDIR)).toBe("/workspace/pkg")
  })

  it("keeps sandbox-host workdirs as-is", () => {
    expect(SandboxPath.toSandboxCwd(undefined, "/workspace")).toBe("/workspace")
    expect(SandboxPath.toSandboxCwd("/workspace/sub", "/workspace")).toBe("/workspace/sub")
  })
})
