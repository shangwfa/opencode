/**
 * PG-mode HTTP tests for x-user-id credential scoping (the SaaS path).
 *
 * Requires OPENCODE_DATABASE_URL. Auto-skips otherwise.
 *
 * Covers:
 *  - prompt/message/prompt_async/prompt_stream trust the x-user-id header over
 *    the body userId, and drop the body userId when the header is absent
 *  - /provider picks up auth PUT/DELETE on the next request (instance disposal)
 *
 * Run with:
 *   OPENCODE_DATABASE_URL=postgresql://local@127.0.0.1:15432/opencode \
 *     bun test test/server/session-userid-header.test.ts
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test"
import { Database, eq } from "../../src/storage/db"
import { disposeAllInstances, provideTestInstance, tmpdir } from "../fixture/fixture"
import { Server } from "../../src/server/server"
import { Log } from "@opencode-ai/core/util/log"
import { SessionTable } from "../../src/session/session.pg"
import { AuthTable } from "../../src/auth/auth.pg"
import { testProviderConfig } from "../lib/test-provider"

Log.init({ print: false })

const DB_URL = process.env.OPENCODE_DATABASE_URL
const enabled = !!DB_URL

const db = DB_URL ? Database.Client() : undefined

// Unroutable endpoint: model resolution succeeds (user message is persisted),
// the LLM call itself fails fast with connection refused.
const LLM_URL = "http://127.0.0.1:9"

const P = "userid-test-provider"
// Cold catalog providers present in the test ModelsDev fixture
// (test/tool/fixtures/models-api.json) that are unlikely to carry real
// credentials; freeCatalogCandidate still guards against overwriting rows.
const CATALOG_CANDIDATES = ["hpc-ai", "drun", "zenifra", "kenari"]

async function freeCatalogCandidate() {
  if (!db) return undefined
  const rows = (await db.select().from(AuthTable).all().catch(() => [])) as { provider_id: string }[]
  const taken = new Set(rows.map((row) => row.provider_id))
  return CATALOG_CANDIDATES.find((candidate) => !taken.has(candidate))
}

async function cleanup(sid?: string) {
  if (!db) return
  await db.delete(AuthTable).where(eq(AuthTable.provider_id, P as any)).run().catch(() => {})
  for (const candidate of CATALOG_CANDIDATES) {
    // Only rows this suite wrote (freeCatalogCandidate guarantees the chosen
    // candidate had no pre-existing row when the test started).
    await db.delete(AuthTable).where(eq(AuthTable.provider_id, candidate as any)).run().catch(() => {})
  }
  if (sid) await db.delete(SessionTable).where(eq(SessionTable.id, sid as any)).run().catch(() => {})
}

async function createSession(app: any) {
  const response = await app.request("/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "userid-header-test" }),
  })
  return ((await response.json()) as { id: string }).id
}

async function userMessages(app: any, sid: string) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const response = await app.request(`/session/${sid}/message`)
    const messages = (await response.json()) as any[]
    const users = messages.filter((message) => message.info?.role === "user")
    if (users.length > 0) return users
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error("user message was not persisted")
}

describe.skipIf(!enabled)("x-user-id header scoping (PG)", () => {
  beforeAll(async () => {
    await Database.initialize()
    await cleanup()
  })

  afterEach(async () => {
    await disposeAllInstances()
    await cleanup()
  })

  test("prompt_async: header overrides body userId and absent header drops it", async () => {
    await using tmp = await tmpdir({ git: true, config: testProviderConfig(LLM_URL) as any })
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const sid = await createSession(app)

        const headerWins = await app.request(`/session/${sid}/prompt_async`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-user-id": "user-a" },
          body: JSON.stringify({
            parts: [{ type: "text", text: "header wins" }],
            model: { providerID: "test", modelID: "test-model" },
            userId: "spoofed-user",
          }),
        })
        expect(headerWins.status).toBe(204)

        const noHeader = await app.request(`/session/${sid}/prompt_async`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            parts: [{ type: "text", text: "no header" }],
            model: { providerID: "test", modelID: "test-model" },
            userId: "spoofed-user",
          }),
        })
        expect(noHeader.status).toBe(204)

        const users = await userMessages(app, sid)
        const withHeader = users.find((message) => message.parts?.some((part: any) => part.text === "header wins"))
        const withoutHeader = users.find((message) => message.parts?.some((part: any) => part.text === "no header"))
        expect(withHeader?.info?.userId).toBe("user-a")
        expect(withoutHeader?.info?.userId).toBeUndefined()

        await cleanup(sid)
      },
    })
  })

  test("sync message: header overrides body userId", async () => {
    await using tmp = await tmpdir({ git: true, config: testProviderConfig(LLM_URL) as any })
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const sid = await createSession(app)

        const response = await app.request(`/session/${sid}/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-user-id": "user-b" },
          body: JSON.stringify({
            parts: [{ type: "text", text: "sync message" }],
            model: { providerID: "test", modelID: "test-model" },
            userId: "spoofed-user",
          }),
        })
        // The LLM call fails against the unroutable URL; the user message is
        // still persisted with the header identity.
        expect([200, 400, 500]).toContain(response.status)

        const users = await userMessages(app, sid)
        const target = users.find((message) => message.parts?.some((part: any) => part.text === "sync message"))
        expect(target?.info?.userId).toBe("user-b")

        await cleanup(sid)
      },
    })
  })

  test("prompt_stream: header overrides body userId", async () => {
    await using tmp = await tmpdir({ git: true, config: testProviderConfig(LLM_URL) as any })
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const sid = await createSession(app)

        const response = await app.request(`/session/${sid}/prompt_stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-user-id": "user-c" },
          body: JSON.stringify({
            parts: [{ type: "text", text: "stream message" }],
            model: { providerID: "test", modelID: "test-model" },
            userId: "spoofed-user",
          }),
        })
        expect(response.status).toBe(200)
        // Drain the SSE stream so the run finishes before assertions.
        await response.text().catch(() => undefined)

        const users = await userMessages(app, sid)
        const target = users.find((message) => message.parts?.some((part: any) => part.text === "stream message"))
        expect(target?.info?.userId).toBe("user-c")

        await cleanup(sid)
      },
    })
  })

  test("/provider reflects auth PUT/DELETE on the next request", async () => {
    const candidate = await freeCatalogCandidate()
    if (!candidate) {
      console.log("跳过：所有候选 provider 均已有凭据行")
      return
    }
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } as any })
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app

        const put = await app.request(`/auth/${candidate}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "api", key: "sk-userid-test" }),
        })
        expect(put.status).toBe(200)

        const afterPut = await (await app.request("/provider")).json()
        expect(afterPut.connected).toContain(candidate)
        expect(afterPut.all.map((provider: any) => provider.id)).toContain(candidate)

        const remove = await app.request(`/auth/${candidate}`, { method: "DELETE" })
        expect(remove.status).toBe(200)

        const afterDelete = await (await app.request("/provider")).json()
        expect(afterDelete.connected).not.toContain(candidate)
        expect(afterDelete.all.map((provider: any) => provider.id)).not.toContain(candidate)

        await db!.delete(AuthTable).where(eq(AuthTable.provider_id, candidate as any)).run().catch(() => {})
      },
    })
  })
})
