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

test("a per-session image is optional and round-trips", () => {
  const decode = Schema.decodeUnknownSync(SessionSandboxResource.Info)
  const encode = Schema.encodeSync(SessionSandboxResource.Info)
  const resource = { cpu: "2", memory: "4Gi", image: "registry.example/opencode-sandbox:session-terminal" }

  // Omitted image means "use the deployment default" and must stay absent on the
  // wire rather than encoding an undefined key.
  expect(encode(decode({ cpu: "2", memory: "4Gi" }))).toEqual({ cpu: "2", memory: "4Gi" })
  expect(encode(decode(resource))).toEqual(resource)
  expect(() => decode({ cpu: "2", memory: "4Gi", image: 7 })).toThrow()
})
