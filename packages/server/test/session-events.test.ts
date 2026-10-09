import { expect } from "bun:test"
import { Effect } from "effect"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { startServer } from "./fixture/server"

const readEvent = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
  const decoder = new TextDecoder()
  let buffer = ""
  while (true) {
    const next = await reader.read()
    if (next.done) throw new Error("SSE stream closed before the expected event")
    buffer += decoder.decode(next.value, { stream: true })
    const boundary = buffer.indexOf("\n\n")
    if (boundary < 0) continue
    const frame = buffer.slice(0, boundary)
    buffer = buffer.slice(boundary + 2)
    const line = frame.split("\n").find((value) => value.startsWith("data: "))
    if (line) return JSON.parse(line.slice(6)) as { type: string; data: Record<string, unknown> }
  }
}

it.live("session event stream filters events to its session", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const server = yield* startServer(directory.path)
    const create = () =>
      Effect.promise(async () => {
        const response = await fetch(new URL("/api/session", server.base), {
          method: "POST",
          headers: { ...server.headers, "content-type": "application/json" },
          body: JSON.stringify({ location: { directory: directory.path } }),
        })
        expect(response.status).toBe(200)
        return ((await response.json()) as { data: { id: string } }).data.id
      })
    const first = yield* create()
    const second = yield* create()
    const response = yield* Effect.promise(() =>
      fetch(new URL(`/api/session/${first}/event`, server.base), { headers: server.headers }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    const reader = response.body!.getReader()
    expect((yield* Effect.promise(() => readEvent(reader))).type).toBe("server.connected")

    for (const [id, title] of [
      [first, "first-updated"],
      [second, "second-updated"],
    ]) {
      const update = yield* Effect.promise(() =>
        fetch(new URL(`/api/session/${id}`, server.base), {
          method: "PATCH",
          headers: { ...server.headers, "content-type": "application/json" },
          body: JSON.stringify({ title }),
        }),
      )
      expect(update.status).toBe(204)
    }

    const event = yield* Effect.promise(() => readEvent(reader))
    expect(event.type).toBe("session.renamed")
    expect(event.data.sessionID).toBe(first)
    yield* Effect.promise(() => reader.cancel())
    for (const id of [first, second]) {
      yield* Effect.promise(() =>
        fetch(new URL(`/api/session/${id}`, server.base), { method: "DELETE", headers: server.headers }),
      )
    }
  }),
)

it.live("prompt_stream admits a prompt and returns its session SSE stream", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const server = yield* startServer(directory.path)
    const created = yield* Effect.promise(async () => {
      const response = await fetch(new URL("/api/session", server.base), {
        method: "POST",
        headers: { ...server.headers, "content-type": "application/json" },
        body: JSON.stringify({ location: { directory: directory.path } }),
      })
      expect(response.status).toBe(200)
      return ((await response.json()) as { data: { id: string } }).data.id
    })

    const response = yield* Effect.promise(() =>
      fetch(new URL(`/api/session/${created}/prompt_stream`, server.base), {
        method: "POST",
        headers: { ...server.headers, "content-type": "application/json" },
        body: JSON.stringify({ text: "SSE prompt stream API test", preset: "read-only", metadata: {}, resume: false }),
      }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    const reader = response.body!.getReader()
    expect((yield* Effect.promise(() => readEvent(reader))).type).toBe("server.connected")
    const admitted = yield* Effect.promise(() => readEvent(reader))
    expect(admitted.type).toBe("session.inbox.enqueued")
    expect(admitted.data.sessionID).toBe(created)
    expect((admitted.data.item as { payload?: { preset?: string } }).payload?.preset).toBe("read-only")
    yield* Effect.promise(() => reader.cancel())
    yield* Effect.promise(() =>
      fetch(new URL(`/api/session/${created}/interrupt`, server.base), {
        method: "POST",
        headers: server.headers,
      }),
    )
    yield* Effect.promise(() =>
      fetch(new URL(`/api/session/${created}`, server.base), { method: "DELETE", headers: server.headers }),
    )
  }),
  20_000,
)

it.live("session event stream rejects an unknown session", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const server = yield* startServer(directory.path)
    const response = yield* Effect.promise(() =>
      fetch(new URL("/api/session/ses_missing_event/event", server.base), { headers: server.headers }),
    )
    expect(response.status).toBe(404)
    yield* Effect.promise(() => response.body?.cancel() ?? Promise.resolve())
  }),
)

it.live("session event stream sets cache headers from the shared SSE shape", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const server = yield* startServer(directory.path)
    const created = yield* Effect.promise(async () => {
      const response = await fetch(new URL("/api/session", server.base), {
        method: "POST",
        headers: { ...server.headers, "content-type": "application/json" },
        body: JSON.stringify({ location: { directory: directory.path } }),
      })
      expect(response.status).toBe(200)
      return ((await response.json()) as { data: { id: string } }).data.id
    })
    const response = yield* Effect.promise(() =>
      fetch(new URL(`/api/session/${created}/event`, server.base), { headers: server.headers }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform")
    expect(response.headers.get("x-accel-buffering")).toBe("no")
    yield* Effect.promise(() => response.body?.cancel() ?? Promise.resolve())
    yield* Effect.promise(() =>
      fetch(new URL(`/api/session/${created}`, server.base), { method: "DELETE", headers: server.headers }),
    )
  }),
)

it.live("prompt_stream rejects an unknown session before opening a stream", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const server = yield* startServer(directory.path)
    const response = yield* Effect.promise(() =>
      fetch(new URL("/api/session/ses_missing_prompt/prompt_stream", server.base), {
        method: "POST",
        headers: { ...server.headers, "content-type": "application/json" },
        body: JSON.stringify({ text: "hello", metadata: {} }),
      }),
    )
    expect(response.status).toBe(404)
    yield* Effect.promise(() => response.body?.cancel() ?? Promise.resolve())
  }),
)

it.live("prompt_stream rejects a malformed payload with a request error", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const server = yield* startServer(directory.path)
    const created = yield* Effect.promise(async () => {
      const response = await fetch(new URL("/api/session", server.base), {
        method: "POST",
        headers: { ...server.headers, "content-type": "application/json" },
        body: JSON.stringify({ location: { directory: directory.path } }),
      })
      expect(response.status).toBe(200)
      return ((await response.json()) as { data: { id: string } }).data.id
    })
    const response = yield* Effect.promise(() =>
      fetch(new URL(`/api/session/${created}/prompt_stream`, server.base), {
        method: "POST",
        headers: { ...server.headers, "content-type": "application/json" },
        body: JSON.stringify({ metadata: {} }),
      }),
    )
    expect(response.status).toBe(400)
    yield* Effect.promise(() => response.body?.cancel() ?? Promise.resolve())
    yield* Effect.promise(() =>
      fetch(new URL(`/api/session/${created}`, server.base), { method: "DELETE", headers: server.headers }),
    )
  }),
)
