import { expect } from "bun:test"
import { Effect } from "effect"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
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
      const response = await handler(new Request(`http://opencode.local${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      }))
      return { status: response.status, result: response.status === 204 ? undefined : await response.json() }
    })
})

const code = (marker: string) => ({
  type: "code",
  code: `export default async () => ({ "session.prompt": (event) => { event.metadata = { marker: "${marker}" } } })`,
})

it.live("covers session plugin CRUD, source redaction, isolation, and idempotency", () =>
  Effect.gen(function* () {
    const request = yield* setup
    const first = yield* request("POST", "/api/session", { title: "session plugin owner" })
    const second = yield* request("POST", "/api/session", { title: "session plugin other" })
    const firstID = (first.result as { data: { id: string } }).data.id
    const secondID = (second.result as { data: { id: string } }).data.id

    const created = yield* request("POST", `/api/session/${firstID}/plugins`, {
      name: "marker-plugin", description: "Session marker", source: code("V1"),
    })
    expect(created.status).toBe(200)
    expect(created.result).toMatchObject({ data: { name: "marker-plugin", source: { type: "code" } } })
    expect(JSON.stringify(created.result)).not.toContain("export default")
    const createdTime = (created.result as { data: { time: { created: number; updated: number } } }).data.time

    const replaced = yield* request("POST", `/api/session/${firstID}/plugins`, {
      name: "marker-plugin", description: "Updated", source: code("V2"),
    })
    const replacedInfo = (replaced.result as { data: { id: string; source: { type: string }; time: { created: number; updated: number } } }).data
    expect(replacedInfo.id).toBe((created.result as { data: { id: string } }).data.id)
    expect(replacedInfo.source).toEqual({ type: "code" })
    expect(JSON.stringify(replaced.result)).not.toContain("export default")
    expect(replacedInfo.time.created).toBe(createdTime.created)
    expect(replacedInfo.time.updated).toBeGreaterThan(createdTime.updated)

    const npm = yield* request("POST", `/api/session/${secondID}/plugins`, {
      name: "npm-plugin", description: "Registry plugin", source: { type: "npm", spec: "@scope/pkg@1.2.3" },
    })
    expect(npm.status).toBe(200)
    expect(npm.result).toMatchObject({ data: { source: { type: "npm", spec: "@scope/pkg@1.2.3" } } })
    const exactSpec = yield* request("POST", `/api/session/${secondID}/plugins`, {
      name: "spec-limit", description: "exact spec length",
      source: { type: "npm", spec: "a".repeat(512) },
    })
    expect(exactSpec.status).toBe(200)
    expect((yield* request("POST", `/api/session/${secondID}/plugins`, {
      name: "spec-oversize", description: "x", source: { type: "npm", spec: "a".repeat(513) },
    })).status).toBe(400)

    const listed = yield* request("GET", `/api/session/${firstID}/plugins`)
    expect(listed.result).toMatchObject({ data: [{ name: "marker-plugin", description: "Updated" }] })
    const other = yield* request("GET", `/api/session/${secondID}/plugins`)
    expect(other.result).toMatchObject({
      data: expect.arrayContaining([expect.objectContaining({ name: "npm-plugin" })]),
    })
    expect(JSON.stringify(other.result)).not.toContain("marker-plugin")

    const exactLimit = yield* request("POST", `/api/session/${firstID}/plugins`, {
      name: "exact-limit", description: "exact UTF-8 byte limit",
      source: { type: "code", code: "x".repeat(256 * 1024) },
    })
    expect(exactLimit.status).toBe(200)
    const exactUnicodeLimit = yield* request("POST", `/api/session/${firstID}/plugins`, {
      name: "exact-unicode-limit", description: "exact multi-byte UTF-8 byte limit",
      source: { type: "code", code: "你".repeat(87_381) + "x" },
    })
    expect(exactUnicodeLimit.status).toBe(200)

    for (const payload of [
      { name: "", description: "x", source: code("X") },
      { name: "bad name", description: "x", source: code("X") },
      { name: "missing-description", source: code("X") },
      { name: "missing-source", description: "x" },
      { name: "unknown-source", description: "x", source: { type: "unknown", code: "x" } },
    ]) {
      expect((yield* request("POST", `/api/session/${firstID}/plugins`, payload)).status).toBe(400)
    }
    expect((yield* request("POST", `/api/session/${firstID}/plugins`, "{ invalid json")).status).toBe(400)
    for (const tooLarge of ["x".repeat(256 * 1024 + 1), "你".repeat(87_381) + "xx"]) {
      expect((yield* request("POST", `/api/session/${firstID}/plugins`, {
        name: "oversized", description: "x", source: { type: "code", code: tooLarge },
      })).status).toBe(413)
    }
    expect((yield* request("POST", "/api/session/ses_NOTEXIST/plugins", {
      name: "ghost", description: "x", source: code("X"),
    })).status).toBe(404)

    expect((yield* request("DELETE", `/api/session/${firstID}/plugins/missing`)).status).toBe(204)
    expect((yield* request("DELETE", `/api/session/${firstID}/plugins/marker-plugin`)).status).toBe(204)
    expect((yield* request("DELETE", `/api/session/${firstID}/plugins/exact-limit`)).status).toBe(204)
    expect((yield* request("DELETE", `/api/session/${firstID}/plugins/exact-unicode-limit`)).status).toBe(204)
    expect((yield* request("GET", `/api/session/${firstID}/plugins`)).result).toMatchObject({ data: [] })
    expect((yield* request("DELETE", `/api/session/${secondID}/plugins`)).status).toBe(204)
    expect((yield* request("DELETE", `/api/session/${firstID}`)).status).toBe(204)
    expect((yield* request("GET", `/api/session/${firstID}/plugins`)).status).toBe(404)
  }),
)

it.live("routes session plugins through internal-child and history-fork resource owners", () =>
  Effect.gen(function* () {
    const request = yield* setup
    const parentResponse = yield* request("POST", "/api/session", { title: "plugin owner parent" })
    const parent = (parentResponse.result as { data: Session.Info }).data
    expect((yield* request("POST", `/api/session/${parent.id}/plugins`, {
      name: "owner-marker", description: "owner", source: code("ROOT"),
    })).status).toBe(200)

    const childResponse = yield* request("POST", "/api/session", { parentID: parent.id })
    const childID = (childResponse.result as { data: { id: string } }).data.id
    expect((yield* request("GET", `/api/session/${childID}/plugins`)).result).toMatchObject({
      data: [{ name: "owner-marker" }],
    })
    expect((yield* request("POST", `/api/session/${childID}/plugins`, {
      name: "child-write", description: "written through child", source: code("CHILD"),
    })).status).toBe(200)
    expect((yield* request("GET", `/api/session/${parent.id}/plugins`)).result).toMatchObject({
      data: expect.arrayContaining([expect.objectContaining({ name: "child-write" })]),
    })

    const importedID = Session.ID.create()
    const imported = yield* request("POST", "/api/experimental/session/import", {
      info: { ...parent, id: importedID, parentID: parent.id },
      messages: [{
        id: SessionMessage.ID.create(), type: "synthetic", text: "fork boundary", time: { created: Date.now() },
      }],
    })
    expect(imported.status).toBe(200)
    const forkResponse = yield* request("POST", `/api/session/${importedID}/fork`, {})
    expect(forkResponse.status).toBe(200)
    const forkID = (forkResponse.result as { data: { id: string } }).data.id
    expect((yield* request("GET", `/api/session/${forkID}/plugins`)).result).toEqual({ data: [] })
    expect((yield* request("POST", `/api/session/${forkID}/plugins`, {
      name: "fork-write", description: "fork domain", source: code("FORK"),
    })).status).toBe(200)
    expect((yield* request("GET", `/api/session/${parent.id}/plugins`)).result).toMatchObject({
      data: expect.not.arrayContaining([expect.objectContaining({ name: "fork-write" })]),
    })
  }).pipe(Effect.scoped),
)
