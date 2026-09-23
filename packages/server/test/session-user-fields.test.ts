import { expect } from "bun:test"
import { Session } from "@opencode/core/session"
import { Effect } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

it.live("accepts session user fields and trusts x-user-id over the prompt body", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-session-user-fields-")))
    const handler = yield* ServerFetch.make({
      app: { version: "test-version" },
      database: { path: ":memory:" },
      fs: { filewatcher: false },
      models: { fetch: false },
    })
    const request = (path: string, options: { body?: unknown; userId?: string } = {}) =>
      Effect.promise(async () => {
        const response = await handler(
          new Request(`http://opencode.local${path}`, {
            method: options.body === undefined ? "GET" : "POST",
            headers: {
              ...(options.body === undefined ? {} : { "content-type": "application/json" }),
              ...(options.userId === undefined ? {} : { "x-user-id": options.userId }),
            },
            body: options.body === undefined ? undefined : JSON.stringify(options.body),
          }),
        )
        return { status: response.status, body: await response.json() }
      })

    const created = yield* request("/api/session", { body: { location: { directory: tmp.path } } })
    const sessionID = (created.body as { data: Session.Info }).data.id

    const accepted = yield* request(`/api/session/${sessionID}/prompt`, {
      userId: "trusted-user",
      body: { text: "identity", userName: "alice", userId: "spoofed-user", resume: false },
    })
    expect(accepted.status).toBe(200)

    const inbox = yield* request(`/api/session/${sessionID}/inbox`)
    expect(inbox.status).toBe(200)
    expect(inbox.body).toMatchObject({
      data: [
        {
          type: "user",
          payload: { text: "identity", userName: "alice", userId: "trusted-user" },
        },
      ],
    })

    const bodyOnly = yield* request(`/api/session/${sessionID}/prompt`, {
      body: { text: "untrusted body id", userName: "bob", userId: "spoofed-user", resume: false },
    })
    expect(bodyOnly.status).toBe(200)

    const all = yield* request(`/api/session/${sessionID}/inbox`)
    expect(all.body).toMatchObject({
      data: [
        { payload: { userId: "trusted-user" } },
        { payload: { userName: "bob" } },
      ],
    })
    expect((all.body as { data: Array<{ payload: Record<string, unknown> }> }).data[1].payload).not.toHaveProperty("userId")
  }),
)
