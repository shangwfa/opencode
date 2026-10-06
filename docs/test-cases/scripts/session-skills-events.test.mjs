import assert from "node:assert/strict"
import { test } from "node:test"
import { toolCalls } from "./session-skills-events.mjs"

test("associate multiple skill calls by invocation ID and skill input, not event ID or order", () => {
  const events = [
    { id: "evt-a", type: "session.tool.input.started", data: { id: "call-doc", name: "skill" } },
    { id: "evt-b", type: "session.tool.input.ended", data: { id: "call-doc", text: '{"id":"resource-check"}' } },
    { id: "evt-c", type: "session.tool.input.started", data: { id: "call-script", name: "skill" } },
    { id: "evt-d", type: "session.tool.input.ended", data: { id: "call-script", text: '{"id":"large-runner"}' } },
    { id: "evt-e", type: "session.tool.success", data: { id: "call-script", content: "script guide" } },
    { id: "evt-f", type: "session.tool.success", data: { id: "call-doc", content: "doc" } },
  ]
  const call = toolCalls(events, "skill").find((call) => call.input?.id === "large-runner")
  assert.equal(call?.success?.data.content, "script guide")
  assert.equal(toolCalls(events, "shell").length, 0)
})

test("incomplete and malformed input does not associate an unrelated success", () => {
  const calls = toolCalls(
    [
      { type: "session.tool.input.started", data: { id: "call-a", name: "skill" } },
      { type: "session.tool.input.ended", data: { id: "call-a", text: "{" } },
      { type: "session.tool.success", data: { id: "call-b" } },
      { type: "session.tool.failed", data: { id: "call-a" } },
    ],
    "skill",
  )
  assert.equal(calls[0].input, undefined)
  assert.equal(calls[0].success, undefined)
  assert.equal(calls[0].failed?.data.id, "call-a")
})
