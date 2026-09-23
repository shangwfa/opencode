import { afterEach, describe, expect, it } from "bun:test"
import { SandboxConfig } from "@opencode/core/sandbox/config"

const KEYS = [
  "OPENCODE_SANDBOX_ENABLED",
  "OPENCODE_SANDBOX_DOMAIN",
  "OPENCODE_SANDBOX_PROTOCOL",
  "OPENCODE_SANDBOX_API_KEY",
  "OPENCODE_SANDBOX_USE_SERVER_PROXY",
  "OPENCODE_SANDBOX_IMAGE",
  "OPENCODE_SANDBOX_TIMEOUT_SECONDS",
  "OPENCODE_SANDBOX_CREATE_TIMEOUT_SECONDS",
  "OPENCODE_SANDBOX_CPU",
  "OPENCODE_SANDBOX_MEMORY",
] as const

afterEach(() => {
  for (const key of KEYS) delete process.env[key]
})

describe("SandboxConfig.load", () => {
  it("stays disabled by default with safe defaults", () => {
    const config = SandboxConfig.load()
    expect(config.enabled).toBe(false)
    expect(config.protocol).toBe("https")
    expect(config.useServerProxy).toBe(false)
    expect(config.apiKey).toBeUndefined()
    expect(config.timeoutSeconds).toBe(30 * 60)
    expect(config.resource).toEqual({ cpu: "2", memory: "4Gi" })
    expect(config.image).toContain("opencode")
  })

  it("enables via true or 1", () => {
    process.env["OPENCODE_SANDBOX_ENABLED"] = "true"
    expect(SandboxConfig.load().enabled).toBe(true)
    process.env["OPENCODE_SANDBOX_ENABLED"] = "1"
    expect(SandboxConfig.load().enabled).toBe(true)
    process.env["OPENCODE_SANDBOX_ENABLED"] = "false"
    expect(SandboxConfig.load().enabled).toBe(false)
  })

  it("reads the connection surface", () => {
    process.env["OPENCODE_SANDBOX_ENABLED"] = "1"
    process.env["OPENCODE_SANDBOX_DOMAIN"] = "sandbox.example.com"
    process.env["OPENCODE_SANDBOX_PROTOCOL"] = "http"
    process.env["OPENCODE_SANDBOX_API_KEY"] = "secret"
    process.env["OPENCODE_SANDBOX_USE_SERVER_PROXY"] = "true"
    const config = SandboxConfig.load()
    expect(config.domain).toBe("sandbox.example.com")
    expect(config.protocol).toBe("http")
    expect(config.apiKey).toBe("secret")
    expect(config.useServerProxy).toBe(true)
  })

  it("keeps defaults for invalid numbers and blanks", () => {
    process.env["OPENCODE_SANDBOX_TIMEOUT_SECONDS"] = "not-a-number"
    process.env["OPENCODE_SANDBOX_API_KEY"] = ""
    process.env["OPENCODE_SANDBOX_IMAGE"] = ""
    const config = SandboxConfig.load()
    expect(config.timeoutSeconds).toBe(30 * 60)
    expect(config.apiKey).toBeUndefined()
    expect(config.image).toContain("opencode")
  })

  it("overrides resource limits and ttl", () => {
    process.env["OPENCODE_SANDBOX_TIMEOUT_SECONDS"] = "600"
    process.env["OPENCODE_SANDBOX_CPU"] = "4"
    process.env["OPENCODE_SANDBOX_MEMORY"] = "8Gi"
    const config = SandboxConfig.load()
    expect(config.timeoutSeconds).toBe(600)
    expect(config.resource).toEqual({ cpu: "4", memory: "8Gi" })
  })

  it("defaults the create timeout and allows overriding it", () => {
    expect(SandboxConfig.load().createTimeoutSeconds).toBe(120)
    process.env["OPENCODE_SANDBOX_CREATE_TIMEOUT_SECONDS"] = "300"
    expect(SandboxConfig.load().createTimeoutSeconds).toBe(300)
    process.env["OPENCODE_SANDBOX_CREATE_TIMEOUT_SECONDS"] = "invalid"
    expect(SandboxConfig.load().createTimeoutSeconds).toBe(120)
  })
})
