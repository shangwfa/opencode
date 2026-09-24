import { expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionSandboxResource } from "../src/session-sandbox-resource.js"

test("session sandbox resource encodes cpu and memory limits", () => {
  const decode = Schema.decodeUnknownSync(SessionSandboxResource.Info)
  const encode = Schema.encodeSync(SessionSandboxResource.Info)
  const resource = { cpu: "500m", memory: "512Mi" }

  expect(encode(decode(resource))).toEqual(resource)
  expect(() => decode({ cpu: "2", memory: 4 })).toThrow()
})
