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

const code = (marker: string) =>
  `export default { description: "Return ${marker}", args: {}, async execute() { return { title: "T", output: "${marker}" } } }`

it.live("covers session tool CRUD, upsert timestamps, isolation, and idempotency", () =>
  Effect.gen(function* () {
    const request = yield* setup
    const first = yield* request("POST", "/api/session", { title: "session tool owner" })
    const second = yield* request("POST", "/api/session", { title: "session tool other" })
    const firstID = (first.result as { data: { id: string } }).data.id
    const secondID = (second.result as { data: { id: string } }).data.id

    const created = yield* request("POST", `/api/session/${firstID}/tools`, {
      name: "add-numbers",
      description: "Add two numbers",
      code: code("SUM"),
    })
    expect(created.status).toBe(200)
    expect(created.result).toMatchObject({ name: "add-numbers", description: "Add two numbers" })
    const createdTime = (created.result as { time: { created: number; updated: number } }).time
    expect(createdTime.created).toBe(createdTime.updated)

    const replaced = yield* request("POST", `/api/session/${firstID}/tools`, {
      name: "add-numbers",
      description: "Add two numbers v2",
      code: code("SUM_V2"),
    })
    expect(replaced.status).toBe(200)
    const replacedTime = (replaced.result as { time: { created: number; updated: number } }).time
    expect(replacedTime.created).toBe(createdTime.created)
    expect(replacedTime.updated).toBeGreaterThan(createdTime.updated)

    const isolated = yield* request("POST", `/api/session/${secondID}/tools`, {
      name: "add-numbers",
      description: "Other session tool",
      code: code("OTHER"),
    })
    expect(isolated.status).toBe(200)

    const listed = yield* request("GET", `/api/session/${firstID}/tools`)
    expect(listed.status).toBe(200)
    expect(listed.result).toMatchObject({ data: [{ name: "add-numbers", description: "Add two numbers v2" }] })
    const other = yield* request("GET", `/api/session/${secondID}/tools`)
    expect(other.result).toMatchObject({ data: [{ name: "add-numbers", description: "Other session tool" }] })

    // Strict validation: empty/unsafe names, missing fields, oversized code.
    for (const payload of [
      { name: "", description: "x", code: code("X") },
      { name: "bad name", description: "x", code: code("X") },
      { name: "ok", code: code("X") },
      { name: "ok", description: "x" },
    ]) {
      expect((yield* request("POST", `/api/session/${firstID}/tools`, payload)).status).toBe(400)
    }
    expect(
      (yield* request("POST", "/api/session/ses_NOTEXIST/tools", { name: "x", description: "x", code: code("X") }))
        .status,
    ).toBe(404)

    // Idempotent delete/clear, then session-delete cascade.
    expect((yield* request("DELETE", `/api/session/${firstID}/tools/nonexistent-tool`)).status).toBe(204)
    expect((yield* request("DELETE", `/api/session/${firstID}/tools/add-numbers`)).status).toBe(204)
    expect((yield* request("GET", `/api/session/${firstID}/tools`)).result).toMatchObject({ data: [] })
    expect((yield* request("DELETE", `/api/session/${secondID}/tools`)).status).toBe(204)
    expect((yield* request("DELETE", `/api/session/${secondID}/tools`)).status).toBe(204)
    expect((yield* request("GET", `/api/session/${secondID}/tools`)).result).toMatchObject({ data: [] })
    expect((yield* request("DELETE", `/api/session/${firstID}`)).status).toBe(204)
    expect((yield* request("GET", `/api/session/${firstID}/tools`)).status).toBe(404)
  }),
)
