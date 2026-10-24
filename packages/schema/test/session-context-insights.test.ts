import { expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionContextInsights } from "../src/session-context-insights.js"
import { EventManifest } from "../src/event-manifest.js"
import { SessionEvent } from "../src/session-event.js"

test("request IDs accept the emitted prefix, not a prefix lookalike", () => {
  expect(Schema.is(SessionContextInsights.RequestID)(SessionContextInsights.RequestID.create())).toBe(true)
  expect(Schema.is(SessionContextInsights.RequestID)("ctxreqNotAnID")).toBe(false)
})

test("optional item fields omit undefined and the canonical event belongs to the public manifest", () => {
  const item = {
    index: 0,
    category: "system" as const,
    name: "system:0",
    estimatedTokens: 5,
    bytes: 4,
    hash: undefined,
    omitted: undefined,
    source: undefined,
  }
  const encoded = Schema.encodeSync(SessionContextInsights.Item)(item)
  expect(Object.hasOwn(encoded, "hash")).toBe(false)
  expect(Object.hasOwn(encoded, "omitted")).toBe(false)
  expect(Object.hasOwn(encoded, "source")).toBe(false)
  expect(Schema.encodeSync(SessionContextInsights.Item)({ ...item, source: "mcp:docs" }).source).toBe("mcp:docs")
  expect(EventManifest.Server.get("session.context.captured")).toBe(SessionEvent.ContextCaptured)
})
