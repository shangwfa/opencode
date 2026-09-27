import { expect } from "bun:test"
import { Effect } from "effect"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const setup = Effect.gen(function* () {
  const handler = yield* ServerFetch.make({
    app: { version: "test" },
    database: { path: ":memory:" },
    fs: { filewatcher: false },
    models: { fetch: false },
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
      const text = response.status === 204 ? "" : await response.text()
      let result: unknown
      if (text) {
        try {
          result = JSON.parse(text)
        } catch {
          result = text
        }
      }
      return { status: response.status, result }
    })
})

it.live("covers session Agent CRUD, partial override merging, isolation, and fallback", () =>
  Effect.gen(function* () {
    const request = yield* setup
    const createdA = yield* request("POST", "/api/session", { title: "session agent owner" })
    const createdB = yield* request("POST", "/api/session", { title: "session agent other" })
    const firstID = (createdA.result as { data: { id: string } }).data.id
    const secondID = (createdB.result as { data: { id: string } }).data.id

    const put = yield* request("POST", `/api/session/${firstID}/agents`, {
      id: "build",
      config: { system: "SESSION_AGENT_SYSTEM", description: "session override" },
    })
    expect(put.status).toBe(200)
    expect(put.result).toMatchObject({ source: "session", agent: { id: "build", system: "SESSION_AGENT_SYSTEM" } })
    const replaced = yield* request("POST", `/api/session/${firstID}/agents`, {
      id: "build",
      config: { system: "SESSION_AGENT_SYSTEM_V2", description: "session override" },
    })
    expect(replaced.status).toBe(200)

    const oversized = yield* request("POST", `/api/session/${firstID}/agents`, {
      id: "build",
      config: { system: "你".repeat(90_000) },
    })
    expect(oversized.status).toBe(413)
    expect(oversized.result).toMatchObject({
      _tag: "SessionAgentContentTooLargeError",
      actualBytes: Buffer.byteLength(JSON.stringify({ system: "你".repeat(90_000) }), "utf8"),
    })

    const custom = yield* request("POST", `/api/session/${firstID}/agents`, {
      id: "session/reviewer",
      config: { system: "SESSION_ONLY_AGENT", mode: "subagent" },
    })
    expect(custom.status).toBe(200)
    const customB = yield* request("POST", `/api/session/${secondID}/agents`, {
      id: "session/reviewer",
      config: { system: "OTHER_SESSION_AGENT", mode: "subagent" },
    })
    expect(customB.status).toBe(200)

    const listA = yield* request("GET", `/api/session/${firstID}/agents`)
    expect(listA.status).toBe(200)
    const itemsA = (
      listA.result as {
        data: Array<{ source: string; agent: { id: string; system?: string; description?: string; mode: string } }>
      }
    ).data
    expect(itemsA.find((item) => item.agent.id === "build")).toMatchObject({
      source: "session",
      agent: { system: "SESSION_AGENT_SYSTEM_V2", description: "session override" },
    })
    expect(itemsA.find((item) => item.agent.id === "session/reviewer")).toMatchObject({
      source: "session",
      agent: { system: "SESSION_ONLY_AGENT", mode: "subagent" },
    })
    const listB = yield* request("GET", `/api/session/${secondID}/agents`)
    const itemsB = (listB.result as { data: Array<{ agent: { id: string; system?: string } }> }).data
    expect(itemsB.find((item) => item.agent.id === "session/reviewer")?.agent.system).toBe("OTHER_SESSION_AGENT")

    const refreshed = yield* request("POST", `/api/session/${firstID}/agents/refresh`)
    expect(refreshed.status).toBe(200)
    expect(
      (refreshed.result as { data: Array<{ agent: { id: string } }> }).data.some(
        (item) => item.agent.id === "session/reviewer",
      ),
    ).toBe(true)

    expect((yield* request("DELETE", `/api/session/${firstID}/agents/build`)).status).toBe(204)
    const afterDelete = yield* request("GET", `/api/session/${firstID}/agents`)
    const itemsAfterDelete = (afterDelete.result as { data: Array<{ source: string; agent: { id: string } }> }).data
    expect(itemsAfterDelete.find((item) => item.agent.id === "build")?.source).not.toBe("session")

    expect((yield* request("DELETE", `/api/session/${firstID}/agents`)).status).toBe(204)
    const invalidMode = yield* request("POST", `/api/session/${firstID}/agents`, {
      id: "invalid-mode",
      config: { mode: "invalid" },
    })
    expect(invalidMode.status).toBe(400)
    const missingID = yield* request("POST", `/api/session/${firstID}/agents`, { config: {} })
    expect(missingID.status).toBe(400)
    expect((yield* request("POST", `/api/session/ses_NOTEXIST/agents`, { id: "reviewer", config: {} })).status).toBe(
      404,
    )
  }),
)
