import { expect, test } from "bun:test"
import * as Contract from "../src/sandbox/contract"
import * as OpenSandbox from "../src/sandbox/opensandbox/provider"
import * as Provider from "../src/sandbox/provider"

test("provider facade preserves the shared service and root-session identity", () => {
  expect(Provider.Service).toBe(Contract.Service)
  expect(Provider.rootSessionID).toBe(Contract.rootSessionID)
  expect(Provider.SandboxProvider.Service).toBe(Contract.Service)
})

test("existing OpenSandbox helper exports keep their original identities", () => {
  expect(Provider.SandboxFilesTimeoutError).toBe(OpenSandbox.SandboxFilesTimeoutError)
  expect(Provider.CommandSessionUnavailable).toBe(OpenSandbox.CommandSessionUnavailable)
  expect(Provider.assembleStreamText).toBe(OpenSandbox.assembleStreamText)
  expect(Provider.resolveSessionImage).toBe(OpenSandbox.resolveSessionImage)
  expect(Provider.refuseCreate).toBe(OpenSandbox.refuseCreate)
  expect(Provider.shouldRetryCreate).toBe(OpenSandbox.shouldRetryCreate)
  expect(Provider.withCommandSessionRecovery).toBe(OpenSandbox.withCommandSessionRecovery)
  expect(Provider.sandboxFilesRequest).toBe(OpenSandbox.sandboxFilesRequest)
})
