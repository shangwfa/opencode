/**
 * 组织自定义角色（P3）。
 * permissions 形如 { requirement: ["read","write"], session: ["read"] }；
 * 内置角色（owner/admin/member/viewer/guest）不可覆盖。
 */
import { Hono } from "hono"
import { and, eq } from "drizzle-orm"
import { member, organization } from "../db/schema.js"
import { z } from "zod"
import { check } from "../authz/index.js"
import { db } from "../db/index.js"
import { orgRole } from "../db/schema.js"
import { writeAudit } from "../lib/audit.js"
import { errors } from "../lib/errors.js"
import { requireAuth, type AppEnv } from "../middleware/auth.js"

export const BUILTIN_ROLES = ["owner", "admin", "member", "viewer", "guest"] as const

const RESOURCE_TYPES = ["org", "project", "requirement", "session", "git_provider"] as const

const createBody = z.object({
  key: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .regex(/^[a-z][a-z0-9_-]*$/, "角色 key 只能是小写字母、数字、下划线、短横线"),
  name: z.string().trim().min(1).max(60),
  permissions: z.partialRecord(z.enum(RESOURCE_TYPES), z.array(z.string().trim().min(1).max(40))),
})

async function assertOrg(userId: string, orgId: string, permission: "read" | "manage") {
  const ok = await check(db, {
    subject: { type: "user", id: userId },
    permission,
    object: { type: "org", id: orgId },
  })
  if (!ok) throw errors.notFound("org")
}

export const orgRoutes = new Hono<AppEnv>()

orgRoutes.use("*", requireAuth)

/** 我所属的组织（创建应用/资源时选择归属） */
orgRoutes.get("/", async (c) => {
  const userId = c.get("userId")
  const rows = await db
    .select({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      role: member.role,
    })
    .from(member)
    .innerJoin(organization, eq(member.organizationId, organization.id))
    .where(eq(member.userId, userId))
  return c.json({ items: rows })
})

orgRoutes.get("/:orgId/roles", async (c) => {
  const orgId = c.req.param("orgId")
  await assertOrg(c.get("userId"), orgId, "read")
  const rows = await db.select().from(orgRole).where(eq(orgRole.orgId, orgId))
  return c.json({
    items: rows.map((r) => ({
      id: r.id,
      key: r.key,
      name: r.name,
      permissions: r.permissions,
      timeCreated: r.timeCreated,
    })),
  })
})

orgRoutes.post("/:orgId/roles", async (c) => {
  const orgId = c.req.param("orgId")
  const userId = c.get("userId")
  await assertOrg(userId, orgId, "manage")

  const parsed = createBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw errors.invalid(issue?.message ?? "参数错误", issue?.path?.join("."))
  }
  const input = parsed.data
  if ((BUILTIN_ROLES as readonly string[]).includes(input.key)) {
    throw errors.invalid("不能覆盖内置角色", "key")
  }

  const existing = await db
    .select({ id: orgRole.id })
    .from(orgRole)
    .where(and(eq(orgRole.orgId, orgId), eq(orgRole.key, input.key)))
    .limit(1)
  if (existing.length > 0) throw errors.conflict("角色 key 已存在", "role_exists")

  const id = `role_${crypto.randomUUID().replace(/-/g, "")}`
  await db.insert(orgRole).values({
    id,
    orgId,
    key: input.key,
    name: input.name,
    permissions: input.permissions as never,
    timeCreated: Date.now(),
  })
  await writeAudit(
    {
      actorId: userId,
      action: "org.role.create",
      resourceType: "org",
      resourceId: orgId,
      metadata: { key: input.key },
    },
    c,
  )

  return c.json({ id, key: input.key, name: input.name, permissions: input.permissions }, 201)
})

orgRoutes.delete("/:orgId/roles/:key", async (c) => {
  const orgId = c.req.param("orgId")
  const key = c.req.param("key")
  const userId = c.get("userId")
  await assertOrg(userId, orgId, "manage")
  if ((BUILTIN_ROLES as readonly string[]).includes(key)) {
    throw errors.invalid("不能删除内置角色", "key")
  }
  await db.delete(orgRole).where(and(eq(orgRole.orgId, orgId), eq(orgRole.key, key)))
  await writeAudit(
    { actorId: userId, action: "org.role.delete", resourceType: "org", resourceId: orgId, metadata: { key } },
    c,
  )
  return c.json({ ok: true })
})
