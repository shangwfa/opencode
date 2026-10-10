import { describe, expect, test } from "bun:test"
import { makePromptStreamTakeUntil, sessionEventFilter } from "../src/session-stream"

const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`

describe("SessionStream.sessionEventFilter", () => {
  const filter = sessionEventFilter("ses_target")

  test("accepts events whose payload carries the session id", () => {
    expect(filter({ data: { sessionID: "ses_target" } })).toBe(true)
    expect(filter({ data: { sessionID: "ses_target", extra: 1 } })).toBe(true)
  })

  test("rejects events for another session", () => {
    expect(filter({ data: { sessionID: "ses_other" } })).toBe(false)
  })

  test("routes form creation using the canonical event payload", () => {
    expect(filter({ data: { sessionID: "ses_target", form: { sessionID: "ses_target" } } })).toBe(true)
    expect(filter({ data: { sessionID: "ses_other", form: { sessionID: "ses_other" } } })).toBe(false)
    expect(filter({ data: { sessionID: "global", form: { sessionID: "global" } } })).toBe(false)
  })

  test("rejects events without a session id", () => {
    expect(filter({ data: {} })).toBe(false)
  })

  test("rejects non-object payloads", () => {
    expect(filter({ data: null })).toBe(false)
    expect(filter({ data: "ses_target" })).toBe(false)
    expect(filter({ data: undefined })).toBe(false)
  })
})

describe("SessionStream.makePromptStreamTakeUntil", () => {
  test("does not end before the admitted inbox item is delivered", () => {
    const done = makePromptStreamTakeUntil("msg_admitted")
    expect(done(frame({ type: "session.execution.succeeded", data: {} }))).toBe(false)
    expect(done(frame({ type: "session.execution.failed", data: {} }))).toBe(false)
  })

  test("does not end on another inbox item's delivery", () => {
    const done = makePromptStreamTakeUntil("msg_admitted")
    expect(done(frame({ type: "session.inbox.delivered", data: { inboxID: "msg_other" } }))).toBe(false)
    expect(done(frame({ type: "session.execution.succeeded", data: {} }))).toBe(false)
  })

  test("ignores non-terminal events after its own delivery", () => {
    const done = makePromptStreamTakeUntil("msg_admitted")
    expect(done(frame({ type: "session.inbox.delivered", data: { inboxID: "msg_admitted" } }))).toBe(false)
    expect(done(frame({ type: "session.step.started", data: {} }))).toBe(false)
    expect(done(frame({ type: "session.inbox.delivered", data: { inboxID: "msg_other" } }))).toBe(false)
  })

  for (const type of [
    "session.execution.succeeded",
    "session.execution.failed",
    "session.execution.interrupted",
  ]) {
    test(`ends after its own delivery and ${type}`, () => {
      const done = makePromptStreamTakeUntil("msg_admitted")
      expect(done(frame({ type: "session.inbox.delivered", data: { inboxID: "msg_admitted" } }))).toBe(false)
      expect(done(frame({ type, data: {} }))).toBe(true)
    })
  }

  test("ignores heartbeats and unparsable frames", () => {
    const done = makePromptStreamTakeUntil("msg_admitted")
    expect(done(": heartbeat\n\n")).toBe(false)
    expect(done("data: not-json\n\n")).toBe(false)
    expect(done("")).toBe(false)
  })

  test("ends only once its own round reaches a terminal state", () => {
    const done = makePromptStreamTakeUntil("msg_admitted")
    expect(done(frame({ type: "session.inbox.delivered", data: { inboxID: "msg_admitted" } }))).toBe(false)
    expect(done(frame({ type: "session.execution.succeeded", data: {} }))).toBe(true)
    expect(done(frame({ type: "session.execution.succeeded", data: {} }))).toBe(true)
  })
})
