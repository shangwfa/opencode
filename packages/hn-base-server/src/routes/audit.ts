/**
 * 审计查询（P3）。
 *  - 平台 admin（user.role=admin）可查全部
 *  - 其他用户只能查自己的操作记录
 */
import { Hono } from "hono"
import { and, desc, eq } from "drizzle-orm"
import { db } from "../db/index.js"
import { auditLog } from "../db/schema.js"
import { requireAuth, type AppEnv } from "../middleware/auth.js"

export const auditRoutes = new Hono<AppEnv>()

auditRoutes.use("*", requireAuth)

auditRoutes.get("/", async (c) => {
  const isAdmin = c.get("userRole") === "admin"
  const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? 50)))
  const action = c.req.query("action")?.trim()
  const resourceType = c.req.query("resourceType")?.trim()

  const conditions = [
    isAdmin ? undefined : eq(auditLog.actorId, c.get("userId")),
    action ? eq(auditLog.action, action) : undefined,
    resourceType ? eq(auditLog.resourceType, resourceType) : undefined,
  ].filter((x): x is NonNullable<typeof x> => Boolean(x))

  const rows = await db
    .select()
    .from(auditLog)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(auditLog.timeCreated))
    .limit(limit)

  return c.json({ items: rows })
})
