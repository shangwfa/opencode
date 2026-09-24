import { expect } from "bun:test"
import { Session } from "@opencode/schema/session"
import { Effect, Schema } from "effect"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const SessionResponse = Schema.Struct({ data: Schema.toEncoded(Session.Info) })

const setup = Effect.gen(function* () {
  const handler = yield* ServerFetch.make({
    app: { version: "test" },
    database: { path: ":memory:" },
    models: { fetch: false },
    fs: { filewatcher: false },
  })
  return (method: string, path: string, body?: unknown) =>
    Effect.promise(async () => {
      const response = await handler(
        new Request(`http://opencode.local${path}`, {
          method,
          headers: { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      )
      const text = await response.text()
      return { status: response.status, body: text ? JSON.parse(text) : undefined }
    })
})

it.live("answers 404 for an unknown session", () =>
  Effect.gen(function* () {
    const request = yield* setup
    const response = yield* request("GET", "/api/session/ses_missing0000000000000000/vcs/diff?mode=working")
    expect(response.status).toBe(404)
  }).pipe(Effect.scoped),
)

it.live("answers 503 when the session sandbox is not enabled", () =>
  Effect.gen(function* () {
    const request = yield* setup
    const created = yield* request("POST", "/api/session", {})
    expect(created.status).toBe(200)
    const session = Schema.decodeUnknownSync(SessionResponse)(created.body).data
    const response = yield* request("GET", `/api/session/${session.id}/vcs/diff?mode=working`)
    expect(response.status).toBe(503)
    expect(JSON.stringify(response.body)).toContain("sandbox")
  }).pipe(Effect.scoped),
)

it.live("rejects an invalid diff mode with HTTP 400", () =>
  Effect.gen(function* () {
    const request = yield* setup
    const created = yield* request("POST", "/api/session", {})
    const session = Schema.decodeUnknownSync(SessionResponse)(created.body).data
    const response = yield* request("GET", `/api/session/${session.id}/vcs/diff?mode=git`)
    expect(response.status).toBe(400)
  }).pipe(Effect.scoped),
)
