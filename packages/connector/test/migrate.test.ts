import { describe, expect, it } from "bun:test"
import { ConnectorMigrate } from "@opencode/connector/adapter/migrate"

const { resolveSearchPath } = ConnectorMigrate

describe("connector migrate search_path resolution", () => {
  it("decodes a url-encoded options parameter", () => {
    const url = "postgresql://user:pass@host:5432/db?options=-c%20search_path%3Dconnector"
    expect(resolveSearchPath(url)).toBe("connector")
  })

  it("accepts a raw unencoded space in the options parameter", () => {
    const url = "postgresql://user:pass@host:5432/db?options=-c search_path=myschema"
    expect(resolveSearchPath(url)).toBe("myschema")
  })

  it("finds search_path regardless of parameter order", () => {
    const url = "postgresql://user:pass@host:5432/db?sslmode=require&options=-c%20search_path%3Dmyschema&connect_timeout=10"
    expect(resolveSearchPath(url)).toBe("myschema")
  })

  it("falls back to the connector schema when search_path is absent", () => {
    expect(resolveSearchPath("postgresql://user:pass@host:5432/db")).toBe("connector")
    expect(resolveSearchPath("postgresql://user:pass@host:5432/db?sslmode=require")).toBe("connector")
  })

  it("takes the first schema of a comma-separated encoded search_path", () => {
    const url = "postgresql://user:pass@host:5432/db?options=-c%20search_path%3Dschema_a%2Cpublic"
    expect(resolveSearchPath(url)).toBe("schema_a")
  })

  it("keeps a literal equals sign unencoded inside an otherwise encoded url", () => {
    const url = "postgresql://user:pass@host:5432/db?options=-c%20search_path=myschema"
    expect(resolveSearchPath(url)).toBe("myschema")
  })
})
