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
      return { status: response.status, result: response.status === 204 ? undefined : await response.json() }
    })
})

it.live("persists Session MCP definitions with upsert, isolation, and strict V2 config", () =>
  Effect.gen(function* () {
    const request = yield* setup
    const first = yield* request("POST", "/api/session", { title: "session mcp owner" })
    const second = yield* request("POST", "/api/session", { title: "session mcp other" })
    const firstID = (first.result as { data: { id: string } }).data.id
    const secondID = (second.result as { data: { id: string } }).data.id

    const created = yield* request("POST", `/api/session/${firstID}/mcps`, {
      name: "docs",
      config: {
        type: "remote",
        url: "https://mcp.example.test",
        headers: { authorization: "Bearer test" },
        oauth: false,
      },
    })
    expect(created.status).toBe(200)
    expect(created.result).toMatchObject({ name: "docs", config: { type: "remote", oauth: false } })

    const replaced = yield* request("POST", `/api/session/${firstID}/mcps`, {
      name: "docs",
      config: { type: "local", command: ["node", "server.mjs"], disabled: true, environment: { NODE_ENV: "test" } },
    })
    expect(replaced.status).toBe(200)
    expect(replaced.result).toMatchObject({ name: "docs", config: { type: "local", disabled: true } })

    const isolated = yield* request("POST", `/api/session/${secondID}/mcps`, {
      name: "docs",
      config: { type: "remote", url: "https://other.example.test", oauth: false },
    })
    expect(isolated.status).toBe(200)

    const listed = yield* request("GET", `/api/session/${firstID}/mcps`)
    expect(listed.status).toBe(200)
    expect(listed.result).toMatchObject({
      data: [{ name: "docs", config: { type: "local", command: ["node", "server.mjs"] } }],
    })
    const other = yield* request("GET", `/api/session/${secondID}/mcps`)
    expect(other.result).toMatchObject({ data: [{ name: "docs", config: { url: "https://other.example.test" } }] })

    expect(
      (yield* request("POST", `/api/session/${firstID}/mcps`, {
        name: "bad/name",
        config: { type: "remote", url: "https://mcp.example.test", oauth: false },
      })).status,
    ).toBe(400)
    expect(
      (yield* request("POST", `/api/session/${firstID}/mcps`, {
        name: "oauth-private",
        config: { type: "remote", url: "https://mcp.example.test" },
      })).status,
    ).toBe(400)
    expect(
      (yield* request("POST", `/api/session/${firstID}/mcps`, { name: "bad", config: { type: "local", command: [] } }))
        .status,
    ).toBe(400)
    expect(
      (yield* request("POST", "/api/session/ses_NOTEXIST/mcps", {
        name: "docs",
        config: { type: "remote", url: "https://mcp.example.test", oauth: false },
      })).status,
    ).toBe(404)

    expect((yield* request("DELETE", `/api/session/${firstID}/mcps/docs`)).status).toBe(204)
    expect((yield* request("DELETE", `/api/session/${secondID}/mcps`)).status).toBe(204)
    expect((yield* request("GET", `/api/session/${firstID}/mcps`)).result).toMatchObject({ data: [] })
    expect((yield* request("GET", `/api/session/${secondID}/mcps`)).result).toMatchObject({ data: [] })
  }),
)
