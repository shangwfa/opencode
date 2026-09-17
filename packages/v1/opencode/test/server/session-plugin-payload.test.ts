import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { PluginCreatePayload } from "../../src/server/routes/instance/httpapi/groups/session"

const decode = Schema.decodeUnknownSync(PluginCreatePayload)

describe("PluginCreatePayload", () => {
  test("accepts code and npm plugins", () => {
    expect(decode({ name: "code", code: "export default async () => ({})" }).name).toBe("code")
    expect(decode({ name: "npm", source: "npm", spec: "example@1.0.0" }).name).toBe("npm")
  })

  test("rejects empty names, code, and npm specs", () => {
    expect(() => decode({ name: "", code: "export default async () => ({})" })).toThrow()
    expect(() => decode({ name: "code", code: "" })).toThrow()
    expect(() => decode({ name: "npm", source: "npm", spec: "" })).toThrow()
  })
})
