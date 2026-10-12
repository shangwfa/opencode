import { describe, expect, it } from "bun:test"
import { ConnectorEngine } from "../src/adapter/engine.js"

// 字段形状来自引擎 /api/connections 的 ManagedConnection 实测（见 e2e/verify-connection-field.mjs）
const managedList = [
  { id: "appledb:default", service: "appledb", connectionName: "default", authType: "no_auth", configured: true, virtual: true, default: true, profile: { accountId: "appledb:public", displayName: "AppleDB Public", grantedScopes: [] } },
  { id: "8a998653-uuid", service: "postmark", connectionName: "0be0ade8-uuid", authType: "api_key", configured: true, virtual: false, default: false, profile: { accountId: "postmark:api_key", displayName: "Postmark API Key", grantedScopes: [] } },
  { id: "legacy-shape", service: "github", alias: "legacy-name", authType: "oauth2" },
]

describe("ConnectorEngine.parseManagedConnections", () => {
  it("reads connectionName (not alias) from managed list responses", () => {
    const parsed = ConnectorEngine.parseManagedConnections(managedList)
    const postmark = parsed.find((row) => row.service === "postmark")
    expect(postmark?.engineConnectionName).toBe("0be0ade8-uuid")
  })

  it("drops virtual no_auth placeholders so reconcile never counts them as orphans", () => {
    const parsed = ConnectorEngine.parseManagedConnections(managedList)
    expect(parsed.some((row) => row.id === "appledb:default")).toBe(false)
    expect(parsed).toHaveLength(2)
  })

  it("falls back to alias for legacy/detail-shaped rows and unwraps envelope data", () => {
    const parsed = ConnectorEngine.parseManagedConnections({ data: managedList })
    expect(parsed.find((row) => row.id === "legacy-shape")?.engineConnectionName).toBe("legacy-name")
  })
})
