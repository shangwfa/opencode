import { expect, test } from "bun:test"
import { Hono } from "hono"
import { SessionID } from "@opencode/schema/session-id"
import { Money } from "@opencode/schema/money"
import { SessionContextInsights as C } from "@opencode/schema/session-context-insights"
import { contextInsightsRoutes } from "../src/routes/context-insights"
import { AppError, errors } from "../src/lib/errors"
import type { AppEnv } from "../src/middleware/auth"

const card = (id: string, title: string, parent: string | null = null): C.SessionCard => ({
  sessionID: SessionID.make(id), title, parentID: parent ? SessionID.make(parent) : null, forkID: null,
  running: false, outcome: null, updated: 0, latest: null,
  usage: { cost: Money.USD.make(1), tokens: { input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
})
function fixture(upstream: (path: string, init?: RequestInit) => Promise<Response>) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => { c.set("userId", "owner"); await next() })
  app.onError((error, c) => error instanceof AppError ? c.json(error.toJSON(), error.status) : c.json({ error: String(error) }, 500))
  app.route("/api/sessions", contextInsightsRoutes({
    requireRead: async (_user, id) => { if (id !== "ses_visible") throw errors.notFound("session") },
    canRead: async (_user, id) => id === "ses_visible",
    visible: async () => ["ses_visible"], upstream,
  }))
  return app
}

test("gateway rejects private sessions before sending any upstream request", async () => {
  let called = false
  const app = fixture(async () => { called = true; return Response.json({}) })
  for (const suffix of ["", "/analysis", "/family", "/requests/ctxreq_private/items/0"]) {
    expect((await app.request(`/api/sessions/ses_hidden/context-insights${suffix}`)).status).toBe(404)
  }
  expect(called).toBe(false)
})

test("family removes private titles, costs, parent identifiers and roots", async () => {
  const app = fixture(async () => Response.json({ data: {
    rootID: "ses_private_root", complete: true, members: [card("ses_private_root", "PRIVATE_TITLE"), card("ses_visible", "Visible", "ses_private_root"), card("ses_private_sibling", "PRIVATE_TITLE")],
  } }))
  const response = await app.request("/api/sessions/ses_visible/context-insights/family")
  expect(response.status).toBe(200)
  const body = (await response.json()) as { data: { members: unknown[] } }
  expect(body).toMatchObject({ data: { rootID: "ses_visible", complete: false, members: [{ sessionID: "ses_visible", parentID: null }] } })
  expect(body.data.members).toHaveLength(1)
  expect(JSON.stringify(body)).not.toContain("private")
  expect(JSON.stringify(body)).not.toContain("PRIVATE_TITLE")
})

test("overview derives its scope from authorization, not client-supplied IDs", async () => {
  let sent: unknown
  const app = fixture(async (_path, init) => {
    sent = JSON.parse(String(init?.body))
    return Response.json({ data: { sessions: [card("ses_visible", "Visible")], days: [], range: { from: 0, to: 1000 }, attribution: "settlement-utc", coverage: "available-durable-events" } })
  })
  const send = (body: unknown) => app.request("/api/sessions/context-insights/overview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  expect((await send({ from: 0, to: 1000, sessionIDs: ["ses_private"] })).status).toBe(400)
  expect(sent).toBeUndefined()
  expect((await send({ from: 0, to: 1000 })).status).toBe(200)
  expect(sent).toEqual({ from: 0, to: 1000, sessionIDs: ["ses_visible"] })
  expect((await send({ from: 1000, to: 0 })).status).toBe(400)
})
