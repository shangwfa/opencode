import { describe, expect, it } from "bun:test"
import { refuseCreate, shouldDegradeDestroy, shouldRetryCreate } from "../src/sandbox/provider.js"
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

describe("destroy-snapshot degradation gate", () => {
  it("degrades only on the final retry with an existing restore point", () => {
    expect(shouldDegradeDestroy(4, 5, "snap-1")).toBe(true)
  })

  it("never degrades before the final retry", () => {
    expect(shouldDegradeDestroy(0, 5, "snap-1")).toBe(false)
    expect(shouldDegradeDestroy(3, 5, "snap-1")).toBe(false)
  })

  it("never degrades without a restorable checkpoint (data protection wins)", () => {
    expect(shouldDegradeDestroy(4, 5, null)).toBe(false)
    expect(shouldDegradeDestroy(4, 5, undefined)).toBe(false)
    expect(shouldDegradeDestroy(4, 5, "")).toBe(false)
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
