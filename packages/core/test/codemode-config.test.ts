import { expect, test } from "bun:test"
import { CodeModeConfig } from "../src/codemode/config"

test("Code Mode defaults to the Session Sandbox with Sandbox-local network and no execution budgets", () => {
  expect(CodeModeConfig.load({})).toEqual({
    executor: "sandbox",
    network: "sandbox",
    limits: {},
  })
})

test("server execution is an explicit compatibility override", () => {
  expect(CodeModeConfig.load({ OPENCODE_CODEMODE_EXECUTOR: "server" }).executor).toBe("server")
  expect(CodeModeConfig.load({ OPENCODE_CODEMODE_EXECUTOR: "server" }).network).toBe("server")
})

test("Sandbox network can be disabled explicitly", () => {
  expect(CodeModeConfig.load({ OPENCODE_CODEMODE_NETWORK: "disabled" }).network).toBe("disabled")
})

test("server network capability can be disabled independently", () => {
  expect(CodeModeConfig.load({ OPENCODE_CODEMODE_EXECUTOR: "server", OPENCODE_CODEMODE_NETWORK: "disabled" }).network).toBe(
    "disabled",
  )
})

test("rejects network modes that target another executor", () => {
  expect(() => CodeModeConfig.load({ OPENCODE_CODEMODE_NETWORK: "server" })).toThrow(
    "incompatible with the sandbox Code Mode executor",
  )
  expect(() => CodeModeConfig.load({ OPENCODE_CODEMODE_EXECUTOR: "server", OPENCODE_CODEMODE_NETWORK: "sandbox" })).toThrow(
    "incompatible with the server Code Mode executor",
  )
})

test("each budget is opt-in and applied independently", () => {
  expect(CodeModeConfig.load({ OPENCODE_CODEMODE_MAX_STEPS: "5000" }).limits).toEqual({ maxSteps: 5000 })
  expect(
    CodeModeConfig.load({ OPENCODE_CODEMODE_TIMEOUT_MS: "1000", OPENCODE_CODEMODE_MAX_OUTPUT_BYTES: "2048" }).limits,
  ).toEqual({ timeoutMs: 1000, maxOutputBytes: 2048 })
})

test("an unusable budget fails loudly instead of silently disabling the cap", () => {
  expect(() => CodeModeConfig.load({ OPENCODE_CODEMODE_MAX_STEPS: "0" })).toThrow(
    "OPENCODE_CODEMODE_MAX_STEPS must be a positive integer",
  )
  expect(() => CodeModeConfig.load({ OPENCODE_CODEMODE_TIMEOUT_MS: "soon" })).toThrow(
    "OPENCODE_CODEMODE_TIMEOUT_MS must be a positive integer",
  )
})
