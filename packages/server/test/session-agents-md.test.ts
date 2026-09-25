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

it.live("covers session AGENTS.md CRUD, upsert, isolation, and deletion", () =>
  Effect.gen(function* () {
    const request = yield* setup
    const first = yield* request("POST", "/api/session", { title: "agents md owner" })
    const second = yield* request("POST", "/api/session", { title: "agents md other" })
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    const firstID = (first.result as { data: { id: string } }).data.id
    const secondID = (second.result as { data: { id: string } }).data.id

    expect((yield* request("GET", `/api/session/${firstID}/agents-md`)).result).toEqual({ data: null })

    const created = yield* request("POST", `/api/session/${firstID}/agents-md`, {
      content: "# Session A\nSESSION_A_RULE",
    })
    expect(created.status).toBe(200)
    expect(created.result).toMatchObject({
      data: { sessionID: firstID, content: "# Session A\nSESSION_A_RULE" },
    })
    const createdInfo = (created.result as { data: { id: string; time: { created: number; updated: number } } }).data
    expect(createdInfo.id).toStartWith("sam_")
    expect(createdInfo.time.created).toBe(createdInfo.time.updated)

    const updated = yield* request("POST", `/api/session/${firstID}/agents-md`, {
      content: "# Replaced\nSESSION_A_REPLACED",
    })
    expect(updated.status).toBe(200)
    expect(updated.result).toMatchObject({ data: { content: "# Replaced\nSESSION_A_REPLACED" } })
    const updatedInfo = (updated.result as { data: { id: string; time: { created: number; updated: number } } }).data
    expect(updatedInfo.id).toBe(createdInfo.id)
    expect(updatedInfo.time.created).toBe(createdInfo.time.created)
    expect(updatedInfo.time.updated).toBeGreaterThan(createdInfo.time.updated)

    const fetched = yield* request("GET", `/api/session/${firstID}/agents-md`)
    expect(fetched.result).toEqual(updated.result)
    expect((yield* request("GET", `/api/session/${secondID}/agents-md`)).result).toEqual({ data: null })

    expect((yield* request("POST", `/api/session/${secondID}/agents-md`, { content: "SESSION_B_RULE" })).status).toBe(200)
    expect((yield* request("GET", `/api/session/${firstID}/agents-md`)).result).toMatchObject({
      data: { content: "# Replaced\nSESSION_A_REPLACED" },
    })
    expect((yield* request("GET", `/api/session/${secondID}/agents-md`)).result).toMatchObject({
      data: { content: "SESSION_B_RULE" },
    })

    expect((yield* request("POST", `/api/session/${firstID}/agents-md`, { content: "" })).result).toMatchObject({
      data: { content: "" },
    })
    const maxContent = "x".repeat(256 * 1024)
    expect((yield* request("POST", `/api/session/${firstID}/agents-md`, { content: maxContent })).status).toBe(200)
    const atLimit = yield* request("GET", `/api/session/${firstID}/agents-md`)
    expect((atLimit.result as { data: { content: string } }).data.content).toHaveLength(256 * 1024)
    const over = yield* request("POST", `/api/session/${firstID}/agents-md`, { content: `${maxContent}x` })
    expect(over.status).toBe(413)
    expect(over.result).toMatchObject({ _tag: "SessionAgentsMdContentTooLargeError", actualBytes: 256 * 1024 + 1 })
    // Rejected writes must leave the stored content untouched.
    const afterOver = yield* request("GET", `/api/session/${firstID}/agents-md`)
    expect((afterOver.result as { data: { content: string } }).data.content).toHaveLength(256 * 1024)

    // The cap counts UTF-8 bytes, not characters: 90000 three-byte characters exceed it
    // while 87381 stay under the 262144-byte limit.
    const multibyteOver = yield* request("POST", `/api/session/${firstID}/agents-md`, {
      content: "你".repeat(90_000),
    })
    expect(multibyteOver.status).toBe(413)
    expect(multibyteOver.result).toMatchObject({ actualBytes: 270_000 })
    expect((yield* request("POST", `/api/session/${firstID}/agents-md`, { content: "你".repeat(87_381) })).status).toBe(
      200,
    )

    const concurrent = yield* Effect.forEach(
      Array.from({ length: 10 }, (_, index) => index),
      (index) => request("POST", `/api/session/${firstID}/agents-md`, { content: `concurrent-${index}` }),
      { concurrency: "unbounded" },
    )
    expect(concurrent.every((item) => item.status === 200)).toBe(true)
    const concurrentResult = yield* request("GET", `/api/session/${firstID}/agents-md`)
    expect((concurrentResult.result as { data: { content: string } }).data.content).toMatch(/^concurrent-\d+$/)

    expect((yield* request("DELETE", `/api/session/${firstID}/agents-md`)).status).toBe(204)
    expect((yield* request("GET", `/api/session/${firstID}/agents-md`)).result).toEqual({ data: null })
    expect((yield* request("DELETE", `/api/session/${firstID}/agents-md`)).status).toBe(204)

    expect((yield* request("POST", `/api/session/${secondID}/agents-md`, {})).status).toBe(400)
    expect((yield* request("GET", "/api/session/ses_NOTEXIST/agents-md")).status).toBe(404)
    expect((yield* request("POST", "/api/session/ses_NOTEXIST/agents-md", { content: "ghost" })).status).toBe(404)

    yield* request("POST", `/api/session/${firstID}/agents-md`, { content: "cascade" })
    expect((yield* request("DELETE", `/api/session/${firstID}`)).status).toBe(204)
    expect((yield* request("GET", `/api/session/${firstID}/agents-md`)).status).toBe(404)
  }).pipe(Effect.scoped),
)
