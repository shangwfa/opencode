import { describe, expect, test } from "bun:test"
import { SessionContextOrigin } from "../src/session/context-origin"

describe("tool provenance", () => {
  test("labels session tools exactly and MCP tools by the longest server prefix", () => {
    const origin = SessionContextOrigin.resolve({ mcp: ["docs", "docs pro"], custom: ["deploy"] })
    expect(origin("deploy")).toBe("session")
    expect(origin("docs_search")).toBe("mcp:docs")
    expect(origin("docs_pro_lookup")).toBe("mcp:docs pro")
    expect(origin("read")).toBeUndefined()
  })

  test("sanitizes registry-unsafe characters the same way the tool registry does", () => {
    const origin = SessionContextOrigin.resolve({ mcp: ["my.server"], custom: ["my tool"] })
    expect(origin("my_server_read")).toBe("mcp:my.server")
    expect(origin("my_tool")).toBe("session")
  })
})
