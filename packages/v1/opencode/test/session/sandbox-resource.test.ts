import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ProjectV2 } from "@opencode-ai/core/project"
import { SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"

const CpuPattern = /^\d+(\.\d+)?m?$/
const MemoryPattern = /^\d+(Ki|Mi|Gi|Ti|K|M|G|T)$/

const baseInfo = {
  id: SessionID.descending(),
  slug: "test-session",
  projectID: ProjectV2.ID.global,
  directory: "/tmp/opencode",
  title: "Test session",
  version: "1.0.0",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
} satisfies Session.Info

describe("SandboxResource schema", () => {
  test("decodes valid cpu and memory", () => {
    expect(Schema.decodeUnknownSync(Session.SandboxResource)({ cpu: "2", memory: "8Gi" })).toEqual({ cpu: "2", memory: "8Gi" })
    expect(Schema.decodeUnknownSync(Session.SandboxResource)({ cpu: "0.5", memory: "512Mi" })).toEqual({ cpu: "0.5", memory: "512Mi" })
    expect(Schema.decodeUnknownSync(Session.SandboxResource)({ cpu: "500m", memory: "1G" })).toEqual({ cpu: "500m", memory: "1G" })
    expect(Schema.decodeUnknownSync(Session.SandboxResource)({ cpu: "4", memory: "1024Ki" })).toEqual({ cpu: "4", memory: "1024Ki" })
    expect(Schema.decodeUnknownSync(Session.SandboxResource)({ cpu: "1", memory: "2Ti" })).toEqual({ cpu: "1", memory: "2Ti" })
  })

  test("accepts single-letter memory suffix (K/M/G/T)", () => {
    expect(Schema.decodeUnknownSync(Session.SandboxResource)({ cpu: "1", memory: "4G" })).toEqual({ cpu: "1", memory: "4G" })
    expect(Schema.decodeUnknownSync(Session.SandboxResource)({ cpu: "1", memory: "500M" })).toEqual({ cpu: "1", memory: "500M" })
  })

  test("rejects missing fields", () => {
    expect(() => Schema.decodeUnknownSync(Session.SandboxResource)({ cpu: "1" })).toThrow()
    expect(() => Schema.decodeUnknownSync(Session.SandboxResource)({ memory: "1Gi" })).toThrow()
    expect(() => Schema.decodeUnknownSync(Session.SandboxResource)({})).toThrow()
  })

  test("rejects non-string values", () => {
    expect(() => Schema.decodeUnknownSync(Session.SandboxResource)({ cpu: 2, memory: "8Gi" })).toThrow()
    expect(() => Schema.decodeUnknownSync(Session.SandboxResource)({ cpu: "1", memory: 2048 })).toThrow()
  })
})

describe("cpu format validation", () => {
  const validCpu = ["1", "0.5", "500m", "2", "0.1", "1000m", "4", "0.25"]
  const invalidCpu = ["", "abc", "-1", "1.5.5", "100mc", "1x", "m", ".5", "5.", "Gi"]

  test.each(validCpu)("accepts valid cpu: %s", (cpu) => {
    expect(CpuPattern.test(cpu)).toBe(true)
  })

  test.each(invalidCpu)("rejects invalid cpu: %s", (cpu) => {
    expect(CpuPattern.test(cpu)).toBe(false)
  })
})

describe("memory format validation", () => {
  const validMemory = ["2Gi", "512Mi", "1G", "1024Ki", "4Ti", "500M", "8Gi", "100K", "2T"]
  const invalidMemory = ["", "2gb", "2gi", "abc", "1024", "-1Gi", "Gi", "1.5Gi", "2 G"]

  test.each(validMemory)("accepts valid memory: %s", (memory) => {
    expect(MemoryPattern.test(memory)).toBe(true)
  })

  test.each(invalidMemory)("rejects invalid memory: %s", (memory) => {
    expect(MemoryPattern.test(memory)).toBe(false)
  })
})

describe("Session.Info sandbox field", () => {
  test("encodes sandbox when provided", () => {
    const encoded = Schema.encodeUnknownSync(Session.Info)({
      ...baseInfo,
      sandbox: { cpu: "2", memory: "8Gi" },
    }) as Record<string, unknown>
    expect(encoded.sandbox).toEqual({ cpu: "2", memory: "8Gi" })
  })

  test("omits sandbox when undefined", () => {
    const encoded = Schema.encodeUnknownSync(Session.Info)({
      ...baseInfo,
      sandbox: undefined,
    }) as Record<string, unknown>
    expect(Object.hasOwn(encoded, "sandbox")).toBe(false)
  })

  test("decodes session with sandbox", () => {
    const decoded = Schema.decodeUnknownSync(Session.Info)({
      ...baseInfo,
      sandbox: { cpu: "4", memory: "16Gi" },
    })
    expect(decoded.sandbox).toEqual({ cpu: "4", memory: "16Gi" })
  })

  test("decodes session without sandbox", () => {
    const decoded = Schema.decodeUnknownSync(Session.Info)({ ...baseInfo })
    expect(decoded.sandbox).toBeUndefined()
  })
})

describe("CreateInput sandbox field", () => {
  test("accepts input with sandbox", () => {
    const decoded = Schema.decodeUnknownSync(Session.CreateInput)({
      sandbox: { cpu: "2", memory: "4Gi" },
    })
    expect(decoded?.sandbox).toEqual({ cpu: "2", memory: "4Gi" })
  })

  test("accepts input without sandbox", () => {
    const decoded = Schema.decodeUnknownSync(Session.CreateInput)({})
    expect(decoded?.sandbox).toBeUndefined()
  })

  test("accepts empty/undefined input", () => {
    expect(Schema.decodeUnknownSync(Session.CreateInput)(undefined)).toBeUndefined()
  })
})

describe("createSandbox resource selection logic", () => {
  const defaultResource = { cpu: "1", memory: "2Gi" }

  function selectResource(
    resolvedSandbox: { cpu: string; memory: string } | undefined,
    defaults: { cpu: string; memory: string },
  ): { cpu: string; memory: string } {
    return resolvedSandbox ?? defaults
  }

  test("uses session sandbox when provided", () => {
    expect(selectResource({ cpu: "4", memory: "8Gi" }, defaultResource)).toEqual({ cpu: "4", memory: "8Gi" })
  })

  test("falls back to default when session has no sandbox", () => {
    expect(selectResource(undefined, defaultResource)).toEqual(defaultResource)
  })

  test("falls back to default for existing sessions (backward compatible)", () => {
    expect(selectResource(undefined, defaultResource)).toEqual({ cpu: "1", memory: "2Gi" })
  })
})

describe("sandbox persistence in toRow/fromRow", () => {
  test("toRow includes sandbox field", () => {
    const row = Session.toRow({
      ...baseInfo,
      sandbox: { cpu: "2", memory: "4Gi" },
    } as Session.Info)
    expect(row.sandbox).toEqual({ cpu: "2", memory: "4Gi" })
  })

  test("toRow produces undefined sandbox when not set", () => {
    const row = Session.toRow(baseInfo as Session.Info)
    expect(row.sandbox).toBeUndefined()
  })
})
