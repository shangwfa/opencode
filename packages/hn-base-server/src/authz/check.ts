/**
 * ReBAC 判定引擎。
 *
 * 规则：
 *  - 默认拒绝（白名单模型）
 *  - 组织成员关系直接查 member 表（不复制到元组）
 *  - parent->perm 沿 parent 关系向上递归（深度上限 MAX_DEPTH）
 *  - 过期/条件不满足则视为不成立
 */
import { and, eq, inArray, or } from "drizzle-orm"
import type { DB } from "../db/index.js"
import { member, orgRole, relationTuple } from "../db/schema.js"
import { evaluateCaveat } from "../lib/caveats.js"
import {
  MAX_DEPTH,
  parseParentPermission,
  permissions,
  type ResourceType,
  type SubjectType,
} from "./schema.js"

export type Subject = { type: SubjectType; id: string }
export type ObjectRef = { type: ResourceType; id: string }

export type DecisionContext = {
  now?: number
  ip?: string
  mfaVerified?: boolean
  [key: string]: unknown
}

export type CheckInput = {
  subject: Subject
  permission: string
  object: ObjectRef
  ctx?: DecisionContext
}

/** 用户所属组织及其角色 */
export async function memberships(db: DB, userId: string) {
  return db.select({ orgId: member.organizationId, role: member.role }).from(member).where(eq(member.userId, userId))
}

function active(row: { expiresAt: number | null; caveatName: string | null; caveatContext: unknown }, ctx?: DecisionContext) {
  const now = ctx?.now ?? Date.now()
  if (row.expiresAt != null && row.expiresAt <= now) return false
  if (!row.caveatName) return true
  return evaluateCaveat(row.caveatName, (row.caveatContext ?? {}) as Record<string, unknown>, ctx)
}

const BUILTIN_ORG_ROLES = ["owner", "admin", "member", "viewer", "guest"]

/** 自定义组织角色：org_role.permissions = { requirement: ["read","write"], ... } */
async function customRoleAllows(
  db: DB,
  orgId: string,
  roleKey: string,
  resourceType: string,
  permission: string,
): Promise<boolean> {
  const rows = await db
    .select({ permissions: orgRole.permissions })
    .from(orgRole)
    .where(and(eq(orgRole.orgId, orgId), eq(orgRole.key, roleKey)))
    .limit(1)
  const permissions = rows[0]?.permissions as Record<string, string[]> | null | undefined
  if (!permissions) return false
  return Array.isArray(permissions[resourceType]) && permissions[resourceType].includes(permission)
}

/** 元组主体是否命中当前用户 */
async function subjectMatches(
  db: DB,
  row: { subjectType: string; subjectId: string },
  subject: Subject,
  orgIds: string[],
): Promise<boolean> {
  if (subject.type === "user") {
    if (row.subjectType === "user") return row.subjectId === subject.id
    if (row.subjectType === "org") return orgIds.includes(row.subjectId)
    if (row.subjectType === "public") return true
    return false
  }
  // 非 user 主体（服务/组织自访）只做精确匹配
  return row.subjectType === subject.type && row.subjectId === subject.id
}

export async function check(db: DB, input: CheckInput): Promise<boolean> {
  return checkInternal(db, input, 0, new Set())
}

async function checkInternal(db: DB, input: CheckInput, depth: number, seen: Set<string>): Promise<boolean> {
  if (depth > MAX_DEPTH) return false
  const key = `${input.object.type}:${input.object.id}:${input.permission}:${input.subject.type}:${input.subject.id}`
  if (seen.has(key)) return false
  seen.add(key)

  const defs = permissions[input.object.type]?.[input.permission]
  if (!defs) return false

  // 组织自身的 owner/admin/member 直接查 member 表
  if (input.object.type === "org" && input.subject.type === "user") {
    const rows = await db
      .select({ role: member.role })
      .from(member)
      .where(and(eq(member.organizationId, input.object.id), eq(member.userId, input.subject.id)))
    const role = rows[0]?.role
    if (role) {
      if (!BUILTIN_ORG_ROLES.includes(role)) {
        // 自定义角色：按 org_role.permissions 判定
        return customRoleAllows(db, input.object.id, role, input.object.type, input.permission)
      }
      for (const def of defs) {
        if (def === "owner" && role === "owner") return true
        if (def === "admin" && (role === "admin" || role === "owner")) return true
        if (def === "member" && ["owner", "admin", "member", "viewer", "guest"].includes(role)) return true
      }
    }
    return false
  }

  const orgIds =
    input.subject.type === "user"
      ? (await memberships(db, input.subject.id)).map((m) => m.orgId)
      : []

  for (const def of defs) {
    const inherited = parseParentPermission(def)
    if (inherited) {
      // 沿 parent 关系找父对象
      const parents = await db
        .select({ subjectType: relationTuple.subjectType, subjectId: relationTuple.subjectId })
        .from(relationTuple)
        .where(
          and(
            eq(relationTuple.resourceType, input.object.type),
            eq(relationTuple.resourceId, input.object.id),
            eq(relationTuple.relation, inherited.relation),
          ),
        )
      for (const parent of parents) {
        if (parent.subjectType === "user" || parent.subjectType === "public") continue
        const ok = await checkInternal(
          db,
          {
            subject: input.subject,
            permission: inherited.permission,
            object: { type: parent.subjectType as ResourceType, id: parent.subjectId },
            ctx: input.ctx,
          },
          depth + 1,
          seen,
        )
        if (ok) return true
      }
      continue
    }

    // 直接关系
    const rows = await db
      .select()
      .from(relationTuple)
      .where(
        and(
          eq(relationTuple.resourceType, input.object.type),
          eq(relationTuple.resourceId, input.object.id),
          eq(relationTuple.relation, def),
        ),
      )
    for (const row of rows) {
      if (!active(row, input.ctx)) continue
      if (await subjectMatches(db, row, input.subject, orgIds)) return true
    }
  }

  return false
}

/**
 * 列表：返回 subject 对某类型资源拥有 permission 的 id。
 * 实现为「候选集 + 逐条 check 校验」的折中：
 *  - 用反向索引缩小候选（subject 直接元组 + 所在组织元组）
 *  - 再逐条 check（保证与单点判定一致，继承链正确）
 * 后续可优化为递归 SQL。
 */
export async function listObjects(
  db: DB,
  input: { subject: Subject; permission: string; type: ResourceType; limit?: number },
): Promise<string[]> {
  const limit = input.limit ?? 200
  const orgIds =
    input.subject.type === "user" ? (await memberships(db, input.subject.id)).map((m) => m.orgId) : []

  const subjectConditions = [
    and(eq(relationTuple.subjectType, "public"), eq(relationTuple.subjectId, "*")),
  ]
  if (input.subject.type === "user") {
    subjectConditions.push(and(eq(relationTuple.subjectType, "user"), eq(relationTuple.subjectId, input.subject.id)))
    if (orgIds.length > 0) {
      subjectConditions.push(and(eq(relationTuple.subjectType, "org"), inArray(relationTuple.subjectId, orgIds)))
    }
  } else {
    subjectConditions.push(
      and(eq(relationTuple.subjectType, input.subject.type), eq(relationTuple.subjectId, input.subject.id)),
    )
  }

  const rows = await db
    .select({ resourceType: relationTuple.resourceType, resourceId: relationTuple.resourceId })
    .from(relationTuple)
    .where(and(eq(relationTuple.resourceType, input.type), or(...subjectConditions)))
    .limit(limit * 4)

  const ids = [...new Set(rows.map((r) => r.resourceId))]
  const out: string[] = []
  for (const id of ids) {
    const ok = await check(db, {
      subject: input.subject,
      permission: input.permission,
      object: { type: input.type, id },
    })
    if (ok) out.push(id)
    if (out.length >= limit) break
  }
  return out
}
