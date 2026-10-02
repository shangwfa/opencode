import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LLM, LLMRequest, Message, ToolDefinition } from "@opencode/ai"
import { ModelRequestLog } from "../src/session/model-request-log"
import { model as openaiModel } from "@opencode/ai/providers/openai"

const request = LLM.request({
  model: openaiModel("gpt-4o-mini", { apiKey: "sk-test" }),
  system: "be concise",
  messages: [Message.user("hello")],
  tools: [
    ToolDefinition.make({ name: "execute", description: "Run code", inputSchema: { type: "object" } }),
    ToolDefinition.make({ name: "inventory.archive_001", description: "Irrelevant", inputSchema: { type: "object" } }),
  ],
})

const input = { sessionID: "ses_log", kind: "primary", agent: "build", request }

test("auditing is off unless a directory is configured", () => {
  expect(ModelRequestLog.directory({})).toBeUndefined()
  expect(ModelRequestLog.file({ OPENCODE_MODEL_REQUEST_LOG: "   " })).toBeUndefined()
  expect(ModelRequestLog.record(input, {})).toBeUndefined()
})

test("records the model-facing tool catalog without credentials or provider settings", () => {
  const directory = mkdtempSync(join(tmpdir(), "model-request-log-"))
  const env = { OPENCODE_MODEL_REQUEST_LOG: directory }
  const withSecrets = LLMRequest.update(request, {
    http: { headers: { authorization: "Bearer secret", "x-session-id": "ses_log" } },
    providerOptions: { openai: { apiKey: "secret" } },
  })

  const entry = ModelRequestLog.record({ ...input, request: withSecrets }, env)
  expect(entry?.toolNames).toEqual(["execute", "inventory.archive_001"])
  expect(entry?.model).toEqual({ id: "gpt-4o-mini", provider: "openai", route: "openai-responses" })
  expect(entry?.truncated).toBe(false)

  const raw = readFileSync(join(directory, "model-requests.jsonl"), "utf8")
  expect(raw).not.toContain("Bearer secret")
  expect(raw).not.toContain("apiKey")
  expect(raw).toContain("be concise")
  expect(raw.split("\n").filter(Boolean)).toHaveLength(1)
})

test("appends one line per request and keeps entries separable by session", () => {
  const directory = mkdtempSync(join(tmpdir(), "model-request-log-"))
  const env = { OPENCODE_MODEL_REQUEST_LOG: directory }
  ModelRequestLog.record(input, env)
  ModelRequestLog.record({ ...input, sessionID: "ses_other" }, env)

  const lines = readFileSync(join(directory, "model-requests.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { sessionID: string })
  expect(lines.map((line) => line.sessionID)).toEqual(["ses_log", "ses_other"])
})

test("marks an oversized request truncated instead of writing a partial record", () => {
  const directory = mkdtempSync(join(tmpdir(), "model-request-log-"))
  const huge = LLMRequest.update(request, { messages: [Message.user("x".repeat(33 * 1024 * 1024))] })
  const entry = ModelRequestLog.record({ ...input, request: huge }, { OPENCODE_MODEL_REQUEST_LOG: directory })
  expect(entry?.truncated).toBe(true)
  expect(entry?.messages).toBeUndefined()
  const raw = readFileSync(join(directory, "model-requests.jsonl"), "utf8")
  expect(raw).toContain('"truncated":true')
  expect(raw.length).toBeLessThan(1024 * 1024)
})
