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

it.live("applies permission presets to the Session or one Agent without dropping Agent fields", () =>
  Effect.gen(function* () {
    const request = yield* setup
    const created = yield* request("POST", "/api/session", { title: "permission preset api" })
    const sessionID = (created.result as { data: { id: string } }).data.id

    const sessionPreset = yield* request("PUT", `/api/session/${sessionID}/permissions/preset`, {
      preset: "read-only",
    })
    expect(sessionPreset.status).toBe(200)
    const sessionPresetData = sessionPreset.result as { preset: string; permissions: unknown[] }
    expect(sessionPresetData.preset).toBe("read-only")
    expect(sessionPresetData.permissions[0]).toEqual({ action: "*", resource: "*", effect: "deny" })
    const session = yield* request("GET", `/api/session/${sessionID}`)
    expect((session.result as { data: { permissions: unknown[] } }).data.permissions).toEqual(
      sessionPresetData.permissions,
    )

    const existing = yield* request("POST", `/api/session/${sessionID}/agents`, {
      id: "build",
      config: { system: "KEEP_AGENT_SYSTEM", description: "Keep this field" },
    })
    expect(existing.status).toBe(200)

    const agentPreset = yield* request("PUT", `/api/session/${sessionID}/agents/build/permissions/preset`, {
      preset: "workspace-write",
    })
    expect(agentPreset.status).toBe(200)
    expect(agentPreset.result).toMatchObject({
      preset: "workspace-write",
      agent: {
        source: "session",
        agent: {
          id: "build",
          system: "KEEP_AGENT_SYSTEM",
          description: "Keep this field",
          permissions: expect.arrayContaining([
            { action: "edit", resource: "*", effect: "allow" },
            { action: "external_directory", resource: "*", effect: "deny" },
          ]),
        },
      },
    })

    const evaluate = (action: string, resource: string) =>
      request("POST", `/api/session/${sessionID}/permission`, {
        action,
        resources: [resource],
        agent: "build",
      })
    expect((yield* evaluate("read", "src/index.ts")).result).toMatchObject({ data: { effect: "allow" } })
    expect((yield* evaluate("edit", "src/index.ts")).result).toMatchObject({ data: { effect: "deny" } })
    expect(
      (yield* request("PUT", `/api/session/${sessionID}/permissions/preset`, { preset: "workspace-write" })).status,
    ).toBe(200)
    expect((yield* evaluate("edit", "src/index.ts")).result).toMatchObject({ data: { effect: "allow" } })
    expect((yield* evaluate("shell", "git status")).result).toMatchObject({ data: { effect: "ask" } })
    expect((yield* evaluate("external_directory", "/tmp/outside")).result).toMatchObject({ data: { effect: "deny" } })

    const full = yield* request("PUT", `/api/session/${sessionID}/agents/build/permissions/preset`, {
      preset: "full-access",
    })
    expect(full.status).toBe(200)
    expect((full.result as { agent: { agent: { permissions: unknown[] } } }).agent.agent.permissions).toContainEqual({
      action: "external_directory",
      resource: "*",
      effect: "allow",
    })
    expect((yield* request("PUT", `/api/session/${sessionID}/permissions/preset`, { preset: "full-access" })).status).toBe(200)
    expect((yield* evaluate("mcp/deploy", "*")).result).toMatchObject({ data: { effect: "allow" } })
    expect((yield* evaluate("external_directory", "/tmp/outside")).result).toMatchObject({ data: { effect: "allow" } })

    expect(
      (yield* request("PUT", `/api/session/${sessionID}/agents/missing/permissions/preset`, { preset: "read-only" }))
        .status,
    ).toBe(404)
    expect(
      (yield* request("PUT", `/api/session/${sessionID}/permissions/preset`, { preset: "invalid" })).status,
    ).toBe(400)
  }),
)
