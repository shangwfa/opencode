import { describe, expect, it } from "bun:test"
import { refuseCreate, shouldRetryCreate } from "../src/sandbox/provider.js"
import { expectedSandboxArch, snapshotDrift } from "../src/sandbox/snapshot.js"

describe("sandbox create retry policy", () => {
  it("retries transient failures while attempts remain", () => {
    expect(shouldRetryCreate(new Error("Sandbox.create failed: Timeout ... Pending"), 0, 3)).toBe(true)
    expect(shouldRetryCreate(new Error("Sandbox.create failed: Timeout ... Pending"), 1, 3)).toBe(true)
  })

  it("stops at the final attempt", () => {
    expect(shouldRetryCreate(new Error("Sandbox.create failed: Timeout ... Pending"), 2, 3)).toBe(false)
  })

  it("never retries snapshot-protection refusals", () => {
    const refusals = [
      refuseCreate("Snapshot persistence is disabled; refusing cold start"),
      refuseCreate("Snapshot restore blocked: snap-1: incompatible: schema 2 != 1"),
      refuseCreate("Snapshot restore failed; retry without cold start: snap-1"),
    ]
    for (const refusal of refusals) {
      expect(shouldRetryCreate(refusal, 0, 3)).toBe(false)
      expect(refusal.message).toContain("[SandboxCreateRefused]")
    }
  })

  it("keeps the refusal reason readable in the message", () => {
    expect(refuseCreate("some reason").message).toBe("[SandboxCreateRefused] some reason")
  })
})

describe("snapshot drift observability", () => {
  it("reports image drift only", () => {
    expect(snapshotDrift({ image: "img-old", arch: "amd64" }, { image: "img-new", arch: "amd64" })).toEqual({
      image: { snapshot: "img-old", expected: "img-new" },
    })
  })

  it("reports arch drift only", () => {
    expect(snapshotDrift({ image: "img", arch: "arm64" }, { image: "img", arch: "amd64" })).toEqual({
      arch: { snapshot: "arm64", expected: "amd64" },
    })
  })

  it("reports both drifts together", () => {
    expect(snapshotDrift({ image: "a", arch: "arm64" }, { image: "b", arch: "amd64" })).toEqual({
      image: { snapshot: "a", expected: "b" },
      arch: { snapshot: "arm64", expected: "amd64" },
    })
  })

  it("returns null when everything matches or stored values are missing", () => {
    expect(snapshotDrift({ image: "img", arch: "amd64" }, { image: "img", arch: "amd64" })).toBeNull()
    expect(snapshotDrift({}, { image: "img", arch: "amd64" })).toBeNull()
    expect(snapshotDrift({ image: null, arch: null }, { image: "img", arch: "amd64" })).toBeNull()
  })

  it("normalizes process arch the same way snapshots store it", () => {
    expect(expectedSandboxArch("x64")).toBe("amd64")
    expect(expectedSandboxArch("arm64")).toBe("arm64")
    expect(snapshotDrift({ arch: "amd64" }, { image: "img", arch: expectedSandboxArch("x64") })).toBeNull()
  })
})
