import { expect } from "bun:test"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
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

it.live("persists sandbox resources through create, parent inheritance, read, and update", () =>
  Effect.gen(function* () {
    const request = yield* setup
    const resource = { cpu: "500m", memory: "512Mi" }
    const created = yield* request("POST", "/api/session", { sandbox: resource })
    expect(created.status).toBe(200)
    const parent = Schema.decodeUnknownSync(SessionResponse)(created.body).data
    expect(parent.sandbox).toEqual(resource)

    const childResponse = yield* request("POST", "/api/session", { parentID: parent.id })
    const child = Schema.decodeUnknownSync(SessionResponse)(childResponse.body).data
    expect(child.sandbox).toEqual(resource)

    const importedID = Session.ID.create()
    const imported = yield* request("POST", "/api/experimental/session/import", {
      info: { ...parent, id: importedID, parentID: parent.id },
      messages: [
        {
          id: SessionMessage.ID.create(),
          type: "synthetic",
          text: "fork-boundary",
          time: { created: Date.now() },
        },
      ],
    })
    expect(imported.status).toBe(200)
    const forkResponse = yield* request("POST", `/api/session/${importedID}/fork`, {})
    const fork = Schema.decodeUnknownSync(SessionResponse)(forkResponse.body).data
    expect(fork.sandbox).toEqual(resource)

    expect(
      (yield* request("PATCH", `/api/session/${parent.id}`, { sandbox: { cpu: "2", memory: "4Gi" } })).status,
    ).toBe(204)
    const read = Schema.decodeUnknownSync(SessionResponse)((yield* request("GET", `/api/session/${parent.id}`)).body)
    expect(read.data.sandbox).toEqual({ cpu: "2", memory: "4Gi" })
  }).pipe(Effect.scoped),
)

it.live("rejects invalid sandbox resource formats with HTTP 400", () =>
  Effect.gen(function* () {
    const request = yield* setup
    const invalidCPU = yield* request("POST", "/api/session", { sandbox: { cpu: "abc", memory: "4Gi" } })
    const invalidMemory = yield* request("POST", "/api/session", { sandbox: { cpu: "2", memory: "8gb" } })
    expect(invalidCPU.status).toBe(400)
    expect(invalidMemory.status).toBe(400)
  }).pipe(Effect.scoped),
)

it.live("leaves sandbox unset when no session resource is supplied", () =>
  Effect.gen(function* () {
    const request = yield* setup
    const created = yield* request("POST", "/api/session", {})
    const session = Schema.decodeUnknownSync(SessionResponse)(created.body).data
    expect(session.sandbox).toBeUndefined()
  }).pipe(Effect.scoped),
)
