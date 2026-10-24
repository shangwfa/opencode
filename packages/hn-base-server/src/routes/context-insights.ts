import { Hono, type Context } from "hono"
import { Schema } from "effect"
import { SessionContextInsights as C } from "@opencode/schema/session-context-insights"
import { z } from "zod"
import type { AppEnv } from "../middleware/auth.js"
import { errors } from "../lib/errors.js"

export function visibleFamily(family: C.Family, allowed: ReadonlySet<string>, requested: C.Family["rootID"]): C.Family {
  const members = family.members.filter((member) => allowed.has(member.sessionID)).map((member) => ({
    ...member,
    parentID: member.parentID && allowed.has(member.parentID) ? member.parentID : null,
    forkID: member.forkID && allowed.has(member.forkID) ? member.forkID : null,
  }))
  return { rootID: allowed.has(family.rootID) ? family.rootID : requested, members, complete: family.complete && members.length === family.members.length }
}

export function contextInsightsRoutes(deps: {
  readonly requireRead: (user: string, session: string, context: Context<AppEnv>) => Promise<void>
  readonly canRead: (user: string, session: string) => Promise<boolean>
  readonly visible: (user: string) => Promise<string[]>
  readonly upstream: (path: string, init?: RequestInit) => Promise<Response>
}) {
  const routes = new Hono<AppEnv>()
  const range = z.object({ from: z.number().int().nonnegative(), to: z.number().int().nonnegative() }).strict()
  routes.post("/context-insights/overview", async (c) => {
    const input = range.safeParse(await c.req.json().catch(() => null))
    if (!input.success || input.data.from >= input.data.to || input.data.to - input.data.from > 400 * 86400000)
      throw errors.invalid("时间范围必须大于零且不超过 400 天")
    const ids = await deps.visible(c.get("userId"))
    const response = await deps.upstream("/api/context-insights/overview", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...input.data, sessionIDs: ids.slice(0, 500) }),
    })
    const result = Schema.decodeUnknownSync(Schema.Struct({ data: C.Overview }))(await response.json())
    return c.json({ ...result, selectionLimited: ids.length > 500 })
  })
  routes.get("/:id/context-insights/family", async (c) => {
    const user = c.get("userId")
    const id = c.req.param("id")
    await deps.requireRead(user, id, c)
    const response = await deps.upstream(`/api/session/${encodeURIComponent(id)}/context-insights/family`)
    const result = Schema.decodeUnknownSync(Schema.Struct({ data: C.Family }))(await response.json())
    const allowed = new Set<string>()
    for (const member of result.data.members) if (await deps.canRead(user, member.sessionID)) allowed.add(member.sessionID)
    return c.json({ data: visibleFamily(result.data, allowed, C.Family.fields.rootID.make(id)) })
  })
  for (const suffix of ["", "/analysis", "/requests", "/requests/:requestID", "/requests/:requestID/items/:index"]) {
    routes.get(`/:id/context-insights${suffix}`, async (c) => {
      const id = c.req.param("id")
      await deps.requireRead(c.get("userId"), id, c)
      let path = `/api/session/${encodeURIComponent(id)}/context-insights`
      if (suffix === "/analysis" || suffix === "/requests") {
        path += suffix
        const query = new URLSearchParams()
        for (const key of ["before", "limit"]) if (c.req.query(key) !== undefined) query.set(key, c.req.query(key) ?? "")
        if (query.size) path += `?${query}`
      } else if (suffix.includes(":requestID")) {
        path += `/requests/${encodeURIComponent(c.req.param("requestID") ?? "")}`
        if (suffix.includes(":index")) path += `/items/${encodeURIComponent(c.req.param("index") ?? "")}`
      }
      const response = await deps.upstream(path)
      return c.json(await response.json())
    })
  }
  return routes
}
