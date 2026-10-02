import { afterEach, describe, expect, it } from "bun:test"
import { SandboxConfig } from "@opencode/core/sandbox/config"

const KEYS = [
  "OPENCODE_SANDBOX_ENABLED",
  "OPENCODE_SANDBOX_DOMAIN",
  "OPENCODE_SANDBOX_PROTOCOL",
  "OPENCODE_SANDBOX_API_KEY",
  "OPENCODE_SANDBOX_USE_SERVER_PROXY",
  "OPENCODE_SANDBOX_MCP_SERVER_PROXY",
  "OPENCODE_SANDBOX_IMAGE",
  "OPENCODE_SANDBOX_TIMEOUT_SECONDS",
  "OPENCODE_SANDBOX_CREATE_TIMEOUT_SECONDS",
  "OPENCODE_SANDBOX_FILES_TIMEOUT_SECONDS",
  "OPENCODE_SANDBOX_FILES_TIMEOUT_RETRIES",
  "OPENCODE_SANDBOX_CPU",
  "OPENCODE_SANDBOX_MEMORY",
  "OPENCODE_SANDBOX_VOLUME_TYPE",
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
    expect(config.timeoutSeconds).toBe(600)
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

  it("defaults the MCP server proxy to on and honors explicit opt-out", () => {
    // Unset: cross-network safe default (gateway), independent of the global flag.
    expect(SandboxConfig.load().mcpServerProxy).toBe(true)
    process.env["OPENCODE_SANDBOX_MCP_SERVER_PROXY"] = "false"
    expect(SandboxConfig.load().mcpServerProxy).toBe(false)
    process.env["OPENCODE_SANDBOX_MCP_SERVER_PROXY"] = "0"
    expect(SandboxConfig.load().mcpServerProxy).toBe(false)
    process.env["OPENCODE_SANDBOX_MCP_SERVER_PROXY"] = "true"
    expect(SandboxConfig.load().mcpServerProxy).toBe(true)
  })

  it("keeps defaults for invalid numbers and blanks", () => {
    process.env["OPENCODE_SANDBOX_TIMEOUT_SECONDS"] = "not-a-number"
    process.env["OPENCODE_SANDBOX_API_KEY"] = ""
    process.env["OPENCODE_SANDBOX_IMAGE"] = ""
    const config = SandboxConfig.load()
    expect(config.timeoutSeconds).toBe(600)
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
    expect(SandboxConfig.load().createTimeoutSeconds).toBe(300)
    process.env["OPENCODE_SANDBOX_CREATE_TIMEOUT_SECONDS"] = "600"
    expect(SandboxConfig.load().createTimeoutSeconds).toBe(600)
    process.env["OPENCODE_SANDBOX_CREATE_TIMEOUT_SECONDS"] = "invalid"
    expect(SandboxConfig.load().createTimeoutSeconds).toBe(300)
  })

  it("bounds files API reads and permits disabling timeout retries", () => {
    expect(SandboxConfig.load().filesTimeoutSeconds).toBe(15)
    expect(SandboxConfig.load().filesTimeoutRetries).toBe(1)
    process.env["OPENCODE_SANDBOX_FILES_TIMEOUT_SECONDS"] = "8"
    process.env["OPENCODE_SANDBOX_FILES_TIMEOUT_RETRIES"] = "0"
    expect(SandboxConfig.load().filesTimeoutSeconds).toBe(8)
    expect(SandboxConfig.load().filesTimeoutRetries).toBe(0)
    process.env["OPENCODE_SANDBOX_FILES_TIMEOUT_SECONDS"] = "0"
    process.env["OPENCODE_SANDBOX_FILES_TIMEOUT_RETRIES"] = "-1"
    expect(SandboxConfig.load().filesTimeoutSeconds).toBe(15)
    expect(SandboxConfig.load().filesTimeoutRetries).toBe(1)
  })

  it("defaults snapshot refresh on and clamps it to a third of the no-volume TTL", () => {
    // V1 parity: periodic refresh protects long-idle sandboxes from platform
    // hard-kills. Default TTL 600s clamps the V1 1800s default to 200s so
    // refresh (interval + 300s scan + commit) lands before the platform
    // reaps the sandbox — an unclamped interval loses every write.
    expect(SandboxConfig.load().snapshot.refreshSeconds).toBe(200)
    process.env["OPENCODE_SANDBOX_TIMEOUT_SECONDS"] = "7200"
    expect(SandboxConfig.load().snapshot.refreshSeconds).toBe(1800)
    process.env["OPENCODE_SANDBOX_TIMEOUT_SECONDS"] = "600"
    process.env["OPENCODE_SANDBOX_SNAPSHOT_REFRESH_SEC"] = "1500"
    expect(SandboxConfig.load().snapshot.refreshSeconds).toBe(1500 > 200 ? 200 : 1500)
    process.env["OPENCODE_SANDBOX_SNAPSHOT_REFRESH_SEC"] = "0"
    expect(SandboxConfig.load().snapshot.refreshSeconds).toBe(0)
    delete process.env["OPENCODE_SANDBOX_SNAPSHOT_REFRESH_SEC"]
    delete process.env["OPENCODE_SANDBOX_TIMEOUT_SECONDS"]
    expect(SandboxConfig.load().snapshot.refreshSeconds).toBe(200)
  })

  it("aligns sandbox TTL defaults with V1 (600s no-volume, 3600s max)", () => {
    expect(SandboxConfig.load().timeoutSeconds).toBe(600)
    expect(SandboxConfig.load().maxTtlSeconds).toBe(3600)
    process.env["OPENCODE_SANDBOX_TIMEOUT_SECONDS"] = "1200"
    expect(SandboxConfig.load().timeoutSeconds).toBe(1200)
    process.env["OPENCODE_SANDBOX_MAX_TTL_SEC"] = "7200"
    expect(SandboxConfig.load().maxTtlSeconds).toBe(7200)
    delete process.env["OPENCODE_SANDBOX_TIMEOUT_SECONDS"]
    delete process.env["OPENCODE_SANDBOX_MAX_TTL_SEC"]
  })

  it("defaults the volume type to pvc; only snapshot is an accepted override (V1 parity)", () => {
    // V1 supported exactly two backends and defaulted to `pvc`: forgetting the
    // env var kept workspaces persistent. Unset, empty, `none`, `host`, and
    // unknown values must all resolve to `pvc` — never silently lose
    // persistence — while an explicit `snapshot` selects the snapshot backend.
    expect(SandboxConfig.load().volumeType).toBe("pvc")
    process.env["OPENCODE_SANDBOX_VOLUME_TYPE"] = "snapshot"
    expect(SandboxConfig.load().volumeType).toBe("snapshot")
    process.env["OPENCODE_SANDBOX_VOLUME_TYPE"] = "pvc"
    expect(SandboxConfig.load().volumeType).toBe("pvc")
    process.env["OPENCODE_SANDBOX_VOLUME_TYPE"] = "none"
    expect(SandboxConfig.load().volumeType).toBe("pvc")
    process.env["OPENCODE_SANDBOX_VOLUME_TYPE"] = "host"
    expect(SandboxConfig.load().volumeType).toBe("pvc")
    process.env["OPENCODE_SANDBOX_VOLUME_TYPE"] = "bogus"
    expect(SandboxConfig.load().volumeType).toBe("pvc")
    process.env["OPENCODE_SANDBOX_VOLUME_TYPE"] = ""
    expect(SandboxConfig.load().volumeType).toBe("pvc")
  })
})
