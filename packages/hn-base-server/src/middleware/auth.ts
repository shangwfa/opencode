/**
 * 认证与授权中间件。
 *  - requireAuth：解析 better-auth session（cookie 或 Bearer），校验账号状态
 *  - requirePermission：ReBAC 判定；失败统一 404（不泄露资源存在性）
 */
import type { Context } from "hono"
import { createMiddleware } from "hono/factory"
import { auth } from "../auth/index.js"
import { check } from "../authz/check.js"
import type { ResourceType } from "../authz/schema.js"
import { db } from "../db/index.js"
import { errors } from "../lib/errors.js"

export type AppEnv = {
  Variables: {
    userId: string
    orgId: string | null
    userRole: string
  }
}

type SessionResult = Awaited<ReturnType<typeof auth.api.getSession>>

export async function readSession(headers: Headers): Promise<NonNullable<SessionResult>> {
  const session = await auth.api.getSession({ headers })
  if (!session) throw errors.unauthorized()
  return session
}

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const session = await readSession(c.req.raw.headers)
  const status = (session.user as { status?: string }).status
  if (status === "disabled") throw errors.unauthorized("账号已禁用")
  c.set("userId", session.user.id)
  c.set("orgId", session.session.activeOrganizationId ?? null)
  c.set("userRole", (session.user as { role?: string }).role ?? "user")
  await next()
})

/**
 * 校验当前用户对某资源拥有 permission。
 * resourceId 从路由参数或请求体解析；无权限 → 404。
 */
export function requirePermission(
  type: ResourceType,
  permission: string,
  resolveId: (c: Context<AppEnv>) => string | undefined,
) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const id = resolveId(c)
    if (!id) throw errors.invalid("缺少资源 ID", "id")
    const ok = await check(db, {
      subject: { type: "user", id: c.get("userId") },
      permission,
      object: { type, id },
    })
    if (!ok) throw errors.notFound(type)
    await next()
  })
}
