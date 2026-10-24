import { expect, test } from "bun:test"
import { SessionContextInsights as C } from "@opencode/schema/session-context-insights"
import { Session } from "@opencode/schema/session"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { SessionMessage } from "@opencode/schema/session-message"
import { eventsOf, filesOf, lineCount, pointOf, statsOf, unionDuration, type EventRow } from "../src/session/context-analysis-fold"

const row = (type: string, seq: number, patch: Partial<EventRow> = {}): EventRow => ({
  type, seq, created: seq * 10, callID: null, assistantID: null, name: null, input: null, nested: null,
  tokens: null, cost: null, model: null, reason: null, ...patch,
})
const assistantID = SessionMessage.ID.create()
const request = C.Request.make({
  id: C.RequestID.create(), sessionID: Session.ID.create(), agent: Agent.ID.make("build"),
  model: { id: Model.ID.make("test"), providerID: Provider.ID.make("test") }, kind: "primary", assistantMessageID: assistantID,
  time: 10, boundary: "model-call-semantic-request", estimation: "text-characters-div-4", estimatedTokens: 100,
  composition: { system: 20, tools: 20, user: 20, inject: 0, assistant: 20, tool: 20 }, incomplete: false, itemCount: 5,
})

test("interval union does not double-count parallel tools", () => {
  expect(unionDuration([[10, 30], [20, 40], [50, 60], [1, -1]])).toBe(40)
})

test("request metrics use only matching assistant settlements and return unknown rather than invented usage", () => {
  const events = [
    row("session.reasoning.started.1", 2, { assistantID }),
    row("session.tool.called.1", 3, { assistantID, callID: "a" }),
    row("session.tool.called.1", 4, { assistantID, callID: "b" }),
    row("session.step.streamed.1", 5, { assistantID }),
    row("session.tool.success.2", 6, { assistantID, callID: "a" }),
    row("session.tool.success.2", 7, { assistantID, callID: "b" }),
    row("session.step.ended.1", 8, { assistantID, tokens: JSON.stringify({ input: 10, output: 2, reasoning: 0, cache: { read: 3, write: 0 } }), cost: 0.1 }),
  ]
  const point = pointOf(request, 1, 1, { ...request, estimatedTokens: 150 }, events)
  expect(point).toMatchObject({ status: "completed", delta: -50, firstContentMs: 10, elapsedMs: 70, modelMs: 40, toolMs: 40, actual: { cost: 0.1 } })
  expect(pointOf({ ...request, assistantMessageID: undefined }, 1, 1, undefined, events).actual).toBeNull()
  expect(pointOf(request, 1, 1, undefined, []).status).toBe("unknown")
})

test("each compaction point takes its own settlement usage instead of the last one in the page", () => {
  const compaction = { ...request, kind: "compaction" as const, assistantMessageID: undefined }
  const ctx = (value: number) => ({ tokens: { input: value, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: value / 1000 })
  const events = [
    row("session.compaction.started", 1, { reason: "auto" }),
    row("session.compaction.ended", 5, { tokens: JSON.stringify(ctx(100).tokens), cost: ctx(100).cost }),
    row("session.compaction.started", 6, { reason: "auto" }),
    row("session.compaction.failed", 9, { tokens: JSON.stringify(ctx(200).tokens), cost: ctx(200).cost }),
  ]
  // Rows are timestamped seq*10: captures at 20 and 70 settle at ended(50) and failed(90).
  const first = pointOf({ ...compaction, time: 20 }, 2, 1, undefined, events)
  const second = pointOf({ ...compaction, time: 70 }, 7, 1, undefined, events)
  expect(first.actual?.tokens.input).toBe(100)
  expect(first.status).toBe("completed")
  expect(second.actual?.tokens.input).toBe(200)
  expect(second.status).toBe("failed")
  // A primary request must not borrow a compaction settlement.
  expect(pointOf({ ...request, time: 20 }, 2, 1, undefined, events).actual).toBeNull()
})

test("file actions include Code Mode nested receipts, failed edits and search scopes, without parsing code as execution", () => {
  const result = filesOf([
    row("session.tool.input.started.1", 1, { callID: "a", name: "read", assistantID }),
    row("session.tool.called.1", 2, { callID: "a", assistantID, input: JSON.stringify({ filePath: "src/a.ts" }) }),
    row("session.tool.success.2", 3, { callID: "a", assistantID }),
    row("session.tool.success.2", 4, { nested: JSON.stringify([
      { tool: "tools.read", input: { path: "/workspace/src/a.ts" }, status: "completed" },
      { tool: "tools.edit", input: { filePath: "src/a.ts" }, status: "error" },
      { tool: "tools.grep", input: { pattern: "token" }, status: "completed" },
      { tool: "tools.write", input: { path: "not-executed" }, status: "running" },
    ]) }),
  ])
  expect(result.find((item) => item.action === "read")).toMatchObject({ path: "/workspace/src/a.ts", calls: 2, nested: 1 })
  expect(result.find((item) => item.action === "write")).toMatchObject({ failed: 1, nested: 1 })
  expect(result.find((item) => item.action === "search")).toMatchObject({ path: "/workspace", target: "scope" })
  expect(JSON.stringify(result)).not.toContain("not-executed")
})

test("line deltas come from mutation inputs and never from read or failed-only writes", () => {
  expect(lineCount("")).toBe(0)
  expect(lineCount("one")).toBe(1)
  expect(lineCount("one\n")).toBe(1)
  expect(lineCount("one\ntwo\n")).toBe(2)
  expect(lineCount("a\r\nb")).toBe(2)

  const result = filesOf([
    row("session.tool.input.started.1", 1, { callID: "w", name: "write", assistantID }),
    row("session.tool.called.1", 2, { callID: "w", assistantID, input: JSON.stringify({ path: "src/new.ts", content: "a\nb\nc\n" }) }),
    row("session.tool.input.started.1", 3, { callID: "e", name: "edit", assistantID }),
    row("session.tool.called.1", 4, { callID: "e", assistantID, input: JSON.stringify({ path: "src/edit.ts", oldString: "x\ny", newString: "x\nz\nw" }) }),
    row("session.tool.input.started.1", 5, { callID: "r", name: "read", assistantID }),
    row("session.tool.called.1", 6, { callID: "r", assistantID, input: JSON.stringify({ path: "src/read.ts" }) }),
    row("session.tool.input.started.1", 7, { callID: "p", name: "patch", assistantID }),
    row("session.tool.called.1", 8, { callID: "p", assistantID, input: JSON.stringify({ patchText: [
      "*** Begin Patch",
      "*** Update File: src/patch.ts",
      "@@ -1,2 +1,2 @@",
      "-old",
      "+new",
      " context",
      "*** End Patch",
    ].join("\n") }) }),
  ])
  expect(result.find((item) => item.path === "/workspace/src/new.ts")).toMatchObject({ added: 3 })
  expect(result.find((item) => item.path === "/workspace/src/new.ts")?.removed).toBeUndefined()
  expect(result.find((item) => item.path === "/workspace/src/edit.ts")).toMatchObject({ added: 3, removed: 2 })
  expect(result.find((item) => item.path === "/workspace/src/read.ts")?.added).toBeUndefined()
  expect(result.find((item) => item.path === "/workspace/src/patch.ts")).toMatchObject({ added: 1, removed: 1 })
})

test("each file row keeps its own operation log, newest first and capped", () => {
  const result = filesOf([
    row("session.tool.input.started.1", 1, { callID: "a", name: "edit", assistantID }),
    row("session.tool.called.1", 2, { callID: "a", assistantID, input: JSON.stringify({ path: "src/a.ts", oldString: "x", newString: "y\nz" }) }),
    row("session.tool.input.started.1", 3, { callID: "b", name: "read", assistantID }),
    row("session.tool.called.1", 4, { callID: "b", assistantID, input: JSON.stringify({ filePath: "src/a.ts" }) }),
  ])
  const write = result.find((item) => item.action === "write")
  expect(write?.ops).toEqual([{ seq: 2, failed: false, nested: false, added: 2, removed: 1 }])
  // A read op carries no line delta at all rather than a zero.
  expect(result.find((item) => item.action === "read")?.ops).toEqual([{ seq: 4, failed: false, nested: false }])
})

test("context events carry their instruction source and the turn they belong to", () => {
  const [event] = eventsOf(
    [row("session.instructions.updated.2", 5, { delta: JSON.stringify({ "project/AGENTS.md": "a".repeat(64), "builtin/x": "removed" }) })],
    [{ seq: 1, turn: 1 }, { seq: 4, turn: 2 }],
  )
  expect(event).toMatchObject({ type: "inject", source: "project/AGENTS.md, builtin/x", turn: 2 })
  const [skill] = eventsOf([row("session.skill.activated.1", 3, { name: "deploy" })], [{ seq: 1, turn: 1 }])
  expect(skill).toMatchObject({ type: "skill", source: "deploy", turn: 1 })
})

test("stats count requests, turns, injects, compactions, skills and per-tool usage", () => {
  const stats = statsOf(
    [
      row("session.instructions.updated.2", 1, { delta: JSON.stringify({ "project/AGENTS.md": "a".repeat(64) }) }),
      row("session.skill.activated.1", 2, { name: "deploy" }),
      row("session.skill.activated.1", 3, { name: "deploy" }),
      row("session.compaction.started.1", 4, { reason: "auto" }),
      row("session.tool.input.started.1", 5, { callID: "a", name: "read", assistantID }),
      row("session.tool.success.2", 6, { callID: "a", assistantID }),
      row("session.tool.input.started.1", 7, { callID: "b", name: "read", assistantID }),
      row("session.tool.failed.2", 8, { callID: "b", assistantID }),
      row("session.tool.input.started.1", 9, { callID: "c", name: "grep", assistantID }),
      row("session.tool.success.2", 10, { callID: "c", assistantID }),
    ],
    [{ seq: 1, turn: 1 }, { seq: 2, turn: 1 }, { seq: 3, turn: 2 }],
    [{ name: "review", calls: 2, last: 100 }],
  )
  expect(stats).toMatchObject({
    requests: 3, turns: 2, steps: 3, injects: 1, compactions: 1, skills: 1, toolCalls: 3,
    tools: [{ name: "read", calls: 2, failed: 1 }, { name: "grep", calls: 1, failed: 0 }],
    commands: [{ name: "review", calls: 2, last: 100 }],
  })
})

test("bad nested metadata is ignored and context events never echo instruction text", () => {
  expect(filesOf([row("session.tool.success.2", 1, { nested: "not-json" })])).toEqual([])
  expect(eventsOf([row("session.instructions.updated.2", 1, { input: "PRIVATE_INSTRUCTION" }), row("session.model.selected.1", 2, { model: '{"providerID":"test","id":"model"}' })])).toEqual([
    { seq: 1, time: 10, type: "inject", label: "instructions.updated" },
    { seq: 2, time: 20, type: "model", label: "model.selected · test · model" },
  ])
})
