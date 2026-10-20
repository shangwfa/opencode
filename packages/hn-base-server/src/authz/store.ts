/**
 * 关系元组读写。
 * 所有授权数据只落 relation_tuple；owner_id/org_id 等字段仅用于查询与展示。
 */
import { and, eq, inArray, or, sql } from "drizzle-orm"
import type { DB } from "../db/index.js"
import { relationTuple } from "../db/schema.js"
import type { ResourceType, SubjectType } from "./schema.js"

export type Tuple = {
  resourceType: ResourceType
  resourceId: string
  relation: string
  subjectType: SubjectType
  subjectId: string
  caveatName?: string | null
  caveatContext?: Record<string, unknown> | null
  expiresAt?: number | null
  createdBy?: string | null
}

function id(): string {
  return `rt_${crypto.randomUUID()}`
}

export async function writeTuples(db: DB, tuples: Tuple[]): Promise<void> {
  if (tuples.length === 0) return
  await db
    .insert(relationTuple)
    .values(
      tuples.map((t) => ({
        id: id(),
        resourceType: t.resourceType,
        resourceId: t.resourceId,
        relation: t.relation,
        subjectType: t.subjectType,
        subjectId: t.subjectId,
        caveatName: t.caveatName ?? null,
        caveatContext: (t.caveatContext ?? null) as never,
        expiresAt: t.expiresAt ?? null,
        createdBy: t.createdBy ?? null,
        timeCreated: Date.now(),
      })),
    )
    // 幂等：重复写入同一元组时忽略
    .onConflictDoNothing()
}

export async function deleteTuples(
  db: DB,
  filter: { resourceType?: string; resourceId?: string; relation?: string; subjectType?: string; subjectId?: string },
): Promise<void> {
  const conditions = [
    filter.resourceType ? eq(relationTuple.resourceType, filter.resourceType) : undefined,
    filter.resourceId ? eq(relationTuple.resourceId, filter.resourceId) : undefined,
    filter.relation ? eq(relationTuple.relation, filter.relation) : undefined,
    filter.subjectType ? eq(relationTuple.subjectType, filter.subjectType) : undefined,
    filter.subjectId ? eq(relationTuple.subjectId, filter.subjectId) : undefined,
  ].filter((c): c is NonNullable<typeof c> => Boolean(c))
  if (conditions.length === 0) return
  await db.delete(relationTuple).where(and(...conditions))
}

/** 删除某资源及其全部子资源的关系（删除资源时调用） */
export async function deleteResourceGraph(db: DB, resourceType: string, resourceId: string): Promise<void> {
  // parent 元组形态：(childType, childId, 'parent', 父类型, 父id)
  const children = await db
    .select({ type: relationTuple.resourceType, id: relationTuple.resourceId })
    .from(relationTuple)
    .where(
      and(
        eq(relationTuple.relation, "parent"),
        eq(relationTuple.subjectType, resourceType as SubjectType),
        eq(relationTuple.subjectId, resourceId),
      ),
    )
  await db
    .delete(relationTuple)
    .where(and(eq(relationTuple.resourceType, resourceType), eq(relationTuple.resourceId, resourceId)))
  for (const child of children) {
    if (!child.type || !child.id) continue
    if (child.type === resourceType && child.id === resourceId) continue
    await deleteResourceGraph(db, child.type, child.id)
  }
}

export async function findTuples(
  db: DB,
  filter: {
    resourceType?: string
    resourceId?: string
    relation?: string
    subjectType?: string
    subjectIds?: string[]
  },
) {
  const conditions = [
    filter.resourceType ? eq(relationTuple.resourceType, filter.resourceType) : undefined,
    filter.resourceId ? eq(relationTuple.resourceId, filter.resourceId) : undefined,
    filter.relation ? eq(relationTuple.relation, filter.relation) : undefined,
    filter.subjectType ? eq(relationTuple.subjectType, filter.subjectType) : undefined,
    filter.subjectIds ? inArray(relationTuple.subjectId, filter.subjectIds) : undefined,
  ].filter((c): c is NonNullable<typeof c> => Boolean(c))
  if (conditions.length === 0) return []
  return db
    .select()
    .from(relationTuple)
    .where(and(...conditions))
}
