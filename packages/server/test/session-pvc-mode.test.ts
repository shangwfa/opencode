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

const create = (request: (method: string, path: string, body?: unknown) => Effect.Effect<{ status: number; body: any }>, body: unknown) =>
  Effect.map(request("POST", "/api/session", body), (response) => ({
    status: response.status,
    session: response.status === 200 ? Schema.decodeUnknownSync(SessionResponse)(response.body).data : undefined,
  }))

// A fork needs one projected message as its boundary.
const forkable = (request: (method: string, path: string, body?: unknown) => Effect.Effect<{ status: number; body: any }>, parentID: string) =>
  Effect.gen(function* () {
    const importedID = Session.ID.create()
    const parent = Schema.decodeUnknownSync(SessionResponse)((yield* request("GET", `/api/session/${parentID}`)).body).data
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
    return importedID
  })

it.live("keeps default sessions free of PVC fields (T38.1)", () =>
  Effect.gen(function* () {
    const request = yield* setup
    const created = yield* create(request, {})
    expect(created.status).toBe(200)
    expect(created.session!.pvcMode).toBeUndefined()
    expect(created.session!.appId).toBeUndefined()
  }).pipe(Effect.scoped),
)

it.live("accepts explicit pvcMode session (T38.2)", () =>
  Effect.gen(function* () {
    const request = yield* setup
    const created = yield* create(request, { pvcMode: "session" })
    expect(created.session!.pvcMode).toBe("session")
  }).pipe(Effect.scoped),
)

it.live("creates app sessions without leaking a worktree directory (T38.3)", () =>
  Effect.gen(function* () {
    const request = yield* setup
    const created = yield* create(request, { pvcMode: "app", appId: "test-app" })
    expect(created.session!.pvcMode).toBe("app")
    expect(created.session!.appId).toBe("test-app")
    expect(created.session!.location.directory).not.toContain("worktrees")
  }).pipe(Effect.scoped),
)

it.live("rejects app mode without appId with HTTP 400 (T38.4)", () =>
  Effect.gen(function* () {
    const request = yield* setup
    expect((yield* create(request, { pvcMode: "app" })).status).toBe(400)
  }).pipe(Effect.scoped),
)

it.live("rejects blank appId with HTTP 400 (T38.5)", () =>
  Effect.gen(function* () {
    const request = yield* setup
    expect((yield* create(request, { pvcMode: "app", appId: "   " })).status).toBe(400)
  }).pipe(Effect.scoped),
)

it.live("rejects invalid pvcMode values with HTTP 400 (T38.6)", () =>
  Effect.gen(function* () {
    const request = yield* setup
    expect((yield* create(request, { pvcMode: "global" })).status).toBe(400)
  }).pipe(Effect.scoped),
)

it.live("rejects path-traversing appId values with HTTP 400 (T38.7)", () =>
  Effect.gen(function* () {
    const request = yield* setup
    const malicious = ["../../sessions/xxx", "apps/../sessions/xxx", "a/b", "a;b", "a rm -rf", "a$HOME"]
    for (const appId of malicious) {
      const created = yield* create(request, { pvcMode: "app", appId })
      expect(created.status).toBe(400)
    }
  }).pipe(Effect.scoped),
)

it.live("rejects overlong appId with HTTP 400 (T38.8)", () =>
  Effect.gen(function* () {
    const request = yield* setup
    expect((yield* create(request, { pvcMode: "app", appId: "a".repeat(129) })).status).toBe(400)
  }).pipe(Effect.scoped),
)

it.live("accepts boundary-char appId values (T38.9)", () =>
  Effect.gen(function* () {
    const request = yield* setup
    for (const appId of ["my-app", "my_app", "my.app", "app-123", "A.B.C-1_2", "a"]) {
      const created = yield* create(request, { pvcMode: "app", appId })
      expect(created.status).toBe(200)
      expect(created.session!.appId).toBe(appId)
      expect(created.session!.pvcMode).toBe("app")
    }
  }).pipe(Effect.scoped),
)

it.live("persists pvcMode and appId through read (T38.18)", () =>
  Effect.gen(function* () {
    const request = yield* setup
    const created = yield* create(request, { pvcMode: "app", appId: "pg-app" })
    const read = Schema.decodeUnknownSync(SessionResponse)((yield* request("GET", `/api/session/${created.session!.id}`)).body).data
    expect(read.pvcMode).toBe("app")
    expect(read.appId).toBe("pg-app")
  }).pipe(Effect.scoped),
)

it.live("fork inherits app pvcMode and appId (T38.19)", () =>
  Effect.gen(function* () {
    const request = yield* setup
    const parent = yield* create(request, { pvcMode: "app", appId: "child-app" })
    const forkableID = yield* forkable(request, parent.session!.id)
    const forked = yield* request("POST", `/api/session/${forkableID}/fork`, {})
    const fork = Schema.decodeUnknownSync(SessionResponse)(forked.body).data
    expect(fork.pvcMode).toBe("app")
    expect(fork.appId).toBe("child-app")
    expect(fork.fork?.sessionID).toBe(forkableID)
  }).pipe(Effect.scoped),
)

it.live("child sessions inherit the parent app PVC scope (T38.20)", () =>
  Effect.gen(function* () {
    const request = yield* setup
    const parent = yield* create(request, { pvcMode: "app", appId: "task-app" })
    const child = yield* create(request, { parentID: parent.session!.id })
    expect(child.session!.pvcMode).toBe("app")
    expect(child.session!.appId).toBe("task-app")
    expect(child.session!.parentID).toBe(parent.session!.id)
  }).pipe(Effect.scoped),
)

it.live("session-mode children and forks stay free of PVC fields (T38.21)", () =>
  Effect.gen(function* () {
    const request = yield* setup
    // Scenario 1: explicit session parent -> child session
    const parentS = yield* create(request, { pvcMode: "session" })
    const childS = yield* create(request, { parentID: parentS.session!.id })
    expect(childS.session!.pvcMode).toBeUndefined()
    expect(childS.session!.appId).toBeUndefined()

    // Scenario 2: explicit session parent -> fork
    const forkableID = yield* forkable(request, parentS.session!.id)
    const forkResponse = yield* request("POST", `/api/session/${forkableID}/fork`, {})
    const fork = Schema.decodeUnknownSync(SessionResponse)(forkResponse.body).data
    expect(fork.pvcMode).toBeUndefined()
    expect(fork.appId).toBeUndefined()

    // Scenario 3: default parent -> child session
    const parentU = yield* create(request, {})
    const childU = yield* create(request, { parentID: parentU.session!.id })
    expect(childU.session!.pvcMode).toBeUndefined()
    expect(childU.session!.appId).toBeUndefined()
  }).pipe(Effect.scoped),
)
