import { expect } from "bun:test"
import { Effect } from "effect"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

type Entry = { id: string; sessionID: string; source: string; detail?: Record<string, unknown> }

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

const listLogs = async (
  request: (method: string, path: string, body?: unknown) => Effect.Effect<{ status: number; result: unknown }>,
  sessionID: string,
) => {
  const response = await Effect.runPromise(request("GET", `/api/session/${sessionID}/logs`))
  expect(response.status).toBe(200)
  return (response.result as { data: Entry[] }).data
}

it.live("audits control-plane session mutations through the log API", () =>
  Effect.gen(function* () {
    const request = yield* setup
    const created = yield* request("POST", "/api/session", { title: "audit owner" })
    expect(created.status).toBe(200)
    const sessionID = (created.result as { data: { id: string } }).data.id

    yield* request("POST", `/api/session/${sessionID}/agents`, {
      id: "session/audit-agent",
      config: { mode: "subagent", description: "audit" },
    })
    yield* request("DELETE", `/api/session/${sessionID}/agents/session%2Faudit-agent`)
    yield* request("POST", `/api/session/${sessionID}/agents-md`, { content: "# audit" })
    yield* request("DELETE", `/api/session/${sessionID}/agents-md`)
    yield* request("POST", `/api/session/${sessionID}/commands`, {
      name: "audit-command",
      template: "echo audit",
    })
    yield* request("PATCH", `/api/session/${sessionID}`, { title: "renamed" })

    const entries = yield* Effect.promise(() => listLogs(request, sessionID))
    expect(entries.map((entry) => entry.source)).toEqual([
      "session.create",
      "session.agentDefinition.create",
      "session.agentDefinition.delete",
      "session.agentsMd.update",
      "session.agentsMd.remove",
      "session.commandDefinition.create",
      "session.update",
    ])
    const created_ = entries[0] as { id: string; detail?: Record<string, unknown> }
    expect(created_.id).toStartWith("log_")
    expect(created_.detail).toEqual({ title: "audit owner" })
    expect((entries[1] as Entry).detail).toEqual({ id: "session/audit-agent" })
    expect((entries[2] as Entry).detail).toEqual({ agentID: "session/audit-agent" })
    expect((entries[3] as Entry).detail).toEqual({ bytes: 7 })
    expect((entries[6] as Entry).detail).toEqual({ title: "renamed" })

    // Limit query keeps oldest-first order and truncates the tail.
    const limited = yield* Effect.promise(async () => {
      const response = await Effect.runPromise(request("GET", `/api/session/${sessionID}/logs?limit=2`))
      return (response.result as { data: Entry[] }).data
    })
    expect(limited.map((entry) => entry.source)).toEqual(["session.create", "session.agentDefinition.create"])

    // `after` cursor pages through the whole trail: page until exhausted, concatenated pages equal the full list.
    const full = yield* Effect.promise(() => listLogs(request, sessionID))
    const collected = yield* Effect.promise(async () => {
      const pages: Entry[] = []
      let after: string | undefined
      for (;;) {
        const response = await Effect.runPromise(
          request("GET", `/api/session/${sessionID}/logs?limit=3${after ? `&after=${encodeURIComponent(after)}` : ""}`),
        )
        const page = (response.result as { data: Entry[] }).data
        pages.push(...page)
        if (page.length < 3) break
        after = page[page.length - 1]!.id
      }
      return pages
    })
    expect(collected.map((entry) => entry.id)).toEqual(full.map((entry) => entry.id))
  }),
)

it.live("audits lifecycle, revert-free mutations, and session definition writes", () =>
  Effect.gen(function* () {
    const request = yield* setup
    const created = yield* request("POST", "/api/session", { title: "lifecycle audit" })
    const sessionID = (created.result as { data: { id: string } }).data.id

    yield* request("POST", `/api/session/${sessionID}/view`, { idle: Date.now() })
    yield* request("PUT", `/api/session/${sessionID}/environment`, { variables: { AUDIT_VAR: "1" } })
    yield* request("POST", `/api/session/${sessionID}/interrupt`)
    yield* request("POST", `/api/session/${sessionID}/background`)
    yield* request("POST", `/api/session/${sessionID}/kill-sandbox`)
    yield* request("POST", `/api/experimental/session/${sessionID}/keep-alive`, { enabled: false })
    yield* request("POST", `/api/session/${sessionID}/synthetic`, {
      text: "audit note",
      description: "audit injection",
      metadata: {},
      delivery: "queue",
    })
    yield* request("POST", `/api/session/${sessionID}/tools`, {
      name: "audit-tool",
      description: "audit tool",
      code: "export default { execute: async () => ({ output: 'ok' }) }",
    })
    yield* request("DELETE", `/api/session/${sessionID}/tools/audit-tool`)
    yield* request("POST", `/api/session/${sessionID}/skills`, {
      id: "audit-skill",
      description: "audit skill",
      content: "# audit skill\nAudit body",
    })
    yield* request("DELETE", `/api/session/${sessionID}/skills/audit-skill`)
    yield* request("POST", `/api/session/${sessionID}/mcps`, {
      name: "audit-mcp",
      config: { type: "local", command: ["echo", "audit"] },
    })
    yield* request("DELETE", `/api/session/${sessionID}/mcps/audit-mcp`)

    const entries = yield* Effect.promise(() => listLogs(request, sessionID))
    expect(entries.map((entry) => entry.source)).toEqual([
      "session.create",
      "session.view",
      "session.environment",
      "session.interrupt",
      "session.background",
      "session.killSandbox",
      "session.keepAlive",
      "session.synthetic",
      "session.toolDefinition.create",
      "session.toolDefinition.delete",
      "session.skillDefinition.create",
      "session.skillDefinition.delete",
      "session.mcpDefinition.create",
      "session.mcpDefinition.delete",
    ])
    expect((entries[1] as Entry).detail).toBeUndefined()
    expect((entries[2] as Entry).detail).toEqual({ variables: ["AUDIT_VAR"] })
    expect((entries[4] as Entry).detail).toBeUndefined()
    expect((entries[5] as Entry).detail).toEqual({ destroyed: false })
    expect((entries[6] as Entry).detail).toEqual({ enabled: false })
    expect((entries[7] as Entry).detail).toEqual({ description: "audit injection", delivery: "queue" })
    expect((entries[8] as Entry).detail).toEqual({ name: "audit-tool" })
    expect((entries[10] as Entry).detail).toEqual({ skill: "audit-skill" })
    expect((entries[12] as Entry).detail).toEqual({ name: "audit-mcp" })
  }),
)

it.live("isolates log entries per session and 404s for missing sessions", () =>
  Effect.gen(function* () {
    const request = yield* setup
    const first = yield* request("POST", "/api/session", { title: "iso first" })
    const second = yield* request("POST", "/api/session", { title: "iso second" })
    const firstID = (first.result as { data: { id: string } }).data.id
    const secondID = (second.result as { data: { id: string } }).data.id
    yield* request("POST", `/api/session/${firstID}/agents`, {
      id: "session/iso",
      config: { mode: "subagent" },
    })

    const firstEntries = yield* Effect.promise(() => listLogs(request, firstID))
    const secondEntries = yield* Effect.promise(() => listLogs(request, secondID))
    expect(firstEntries.map((entry) => entry.source)).toEqual(["session.create", "session.agentDefinition.create"])
    expect(secondEntries.map((entry) => entry.source)).toEqual(["session.create"])
    expect(secondEntries[0]?.sessionID).toBe(secondID)

    const missing = yield* request("GET", "/api/session/ses_missing/logs")
    expect(missing.status).toBe(404)
  }),
)
