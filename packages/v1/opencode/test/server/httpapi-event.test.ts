import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer, Queue, Schema, Stream } from "effect"
import { EventPaths } from "../../src/server/routes/instance/httpapi/groups/event"
import { eventVisible } from "../../src/server/routes/instance/httpapi/handlers/event"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const EventData = Schema.Struct({
  id: Schema.optional(Schema.String),
  type: Schema.String,
  properties: Schema.Record(Schema.String, Schema.Any),
})

const readEvent = (reader: Queue.Dequeue<Uint8Array>) =>
  Effect.gen(function* () {
    const value = yield* Queue.take(reader).pipe(
      Effect.timeoutOrElse({
        duration: "5 seconds",
        orElse: () => Effect.fail(new Error("timed out waiting for event")),
      }),
    )
    return Schema.decodeUnknownSync(EventData)(JSON.parse(new TextDecoder().decode(value).replace(/^data: /, "")))
  })

const openEventStream = (directory: string) =>
  Effect.gen(function* () {
    const response = yield* requestInDirectory(EventPaths.event, directory)
    const reader = yield* Queue.unbounded<Uint8Array>()
    yield* response.stream.pipe(
      Stream.runForEach((value) => Queue.offer(reader, value)),
      Effect.forkScoped,
    )
    return { response, reader }
  })

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const it = testEffect(httpApiLayer)

describe("event HttpApi", () => {
  it.instance(
    "serves event stream",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const { response, reader } = yield* openEventStream(directory)

        expect(response.status).toBe(200)
        expect(response.headers["content-type"]).toContain("text/event-stream")
        expect(response.headers["cache-control"]).toBe("no-cache, no-transform")
        expect(response.headers["x-accel-buffering"]).toBe("no")
        expect(response.headers["x-content-type-options"]).toBe("nosniff")
        expect(yield* readEvent(reader)).toMatchObject({ type: "server.connected", properties: {} })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "keeps the event stream open after the initial event",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const { reader } = yield* openEventStream(directory)
        expect(yield* readEvent(reader)).toMatchObject({ type: "server.connected", properties: {} })

        // If no second event arrives within 250ms, the stream is still open.
        const status = yield* Queue.take(reader).pipe(
          Effect.as("event" as const),
          Effect.timeoutOrElse({ duration: "250 millis", orElse: () => Effect.succeed("open" as const) }),
        )
        expect(status).toBe("open")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "delivers instance events after the initial event",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const { reader } = yield* openEventStream(directory)
        expect(yield* readEvent(reader)).toMatchObject({ type: "server.connected", properties: {} })

        const created = yield* requestInDirectory("/session", directory, { method: "POST" })
        expect(created.status).toBe(200)
        expect(yield* readEvent(reader)).toMatchObject({ type: "session.created" })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  // End-to-end ?after=<seq> catch-up is covered by docs/test-cases/session/sse.md
  // T9.35 (integration, PG): the in-memory SQLite fixture cannot create sessions
  // (known core migration baseline drift, see AGENTS.md).
})

describe("eventVisible", () => {
  const instance = { directory: "/workspace", workspaceID: undefined }
  const payload = (event: { id: string; type: string; location?: { directory: string; workspaceID?: string }; data: {} }) =>
    event as unknown as import("@opencode-ai/core/event").EventV2.Payload

  test("drops located events from another directory", () => {
    expect(
      eventVisible(instance)(payload({ id: "evt_1", type: "session.updated", location: { directory: "/other" }, data: {} })),
    ).toBe(false)
  })

  test("passes located events matching the instance directory", () => {
    expect(
      eventVisible(instance)(payload({ id: "evt_1", type: "session.updated", location: { directory: "/workspace" }, data: {} })),
    ).toBe(true)
  })

  test("passes events without a location (global or replayed)", () => {
    expect(eventVisible(instance)(payload({ id: "evt_1", type: "session.updated", data: {} }))).toBe(true)
  })

  test("filters located events by workspace when set", () => {
    const workspace = { directory: "/workspace", workspaceID: "ws_1" }
    expect(
      eventVisible(workspace)(
        payload({ id: "evt_1", type: "session.updated", location: { directory: "/workspace", workspaceID: "ws_1" }, data: {} }),
      ),
    ).toBe(true)
    expect(
      eventVisible(workspace)(
        payload({ id: "evt_1", type: "session.updated", location: { directory: "/workspace", workspaceID: "ws_2" }, data: {} }),
      ),
    ).toBe(false)
  })

  test("applies the caller filter in addition to visibility", () => {
    const visible = eventVisible(instance, (event) => event.type === "session.updated")
    expect(visible(payload({ id: "evt_1", type: "session.updated", data: {} }))).toBe(true)
    expect(visible(payload({ id: "evt_1", type: "session.error", data: {} }))).toBe(false)
  })
})
