import { expect } from "bun:test"
import { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const setup = Effect.gen(function* () {
  const handler = yield* ServerFetch.make({
    app: { version: "test" },
    database: { path: ":memory:" },
    fs: { filewatcher: false },
  })
  return (path: string, body?: unknown, status = 200) =>
    Effect.promise(async () => {
      const response = await handler(
        new Request(`http://opencode.local${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      )
      const json: unknown = await response.json()
      expect(response.status).toBe(status)
      return json
    })
})

it.live("returns 404 for a missing parentID without creating the session", () =>
  Effect.gen(function* () {
    const request = yield* setup
    const parentID = Session.ID.create()
    const id = Session.ID.create()
    const error = yield* request("/api/session", { id, parentID }, 404)
    expect(error).toMatchObject({ _tag: "SessionNotFoundError", sessionID: parentID })
    expect(yield* request(`/api/session/${id}`, undefined, 404)).toMatchObject({
      _tag: "SessionNotFoundError",
      sessionID: id,
    })
  }).pipe(Effect.scoped),
)

it.live("creates a session with a client-supplied id and stays idempotent", () =>
  Effect.gen(function* () {
    const request = yield* setup
    const id = Session.ID.create()
    const first = yield* request("/api/session", { id, title: "once" })
    const second = yield* request("/api/session", { id, title: "twice" })
    expect(first).toEqual(second)
    expect(first).toMatchObject({ data: { id, title: "once" } })
  }).pipe(Effect.scoped),
)
