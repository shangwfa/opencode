import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { McpCreatePayload } from "@/server/routes/instance/httpapi/groups/session"

const decode = Schema.decodeUnknownOption(McpCreatePayload)

describe("McpCreatePayload", () => {
  test("accepts local MCP with non-empty command", () => {
    const result = decode({ name: "local", type: "local", command: ["npx", "server"], environment: { TOKEN: "x" } })
    expect(result._tag).toBe("Some")
  })

  test("rejects local MCP without command", () => {
    expect(decode({ name: "local", type: "local" })._tag).toBe("None")
  })

  test("rejects local MCP with empty command", () => {
    expect(decode({ name: "local", type: "local", command: [] })._tag).toBe("None")
  })

  test("accepts remote MCP with url", () => {
    const result = decode({ name: "remote", type: "remote", url: "https://example.com/mcp", headers: { Authorization: "Bearer x" } })
    expect(result._tag).toBe("Some")
  })

  test("rejects remote MCP without url", () => {
    expect(decode({ name: "remote", type: "remote" })._tag).toBe("None")
  })
})
