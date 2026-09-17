// hitl_request 表的持久化操作。仅在 PG 模式生效（enabled()）；SQLite 模式下
// question/permission service 退回纯内存行为（上游单机语义）。
// 所有状态迁移都是 CAS（WHERE status = 'pending'），天然幂等；返回 outcome 让
// 调用方区分「本次迁移成功」与「行已终态」（跨实例迟到/重复提交）。
import { and, eq, inArray, lt, ne, sql } from "drizzle-orm"
import { Database } from "@/storage/db"
import { HitlRequestTable } from "./request.pg"

export type Kind = "question" | "permission"
export type Status = "pending" | "replied" | "rejected" | "closed"
export type CloseReason = "instance-restart" | "shutdown" | "answered-delivered" | "decision-delivered"

export const enabled = () => Database.dialect === "pg"

// 租约参数：持有实例每 30 个轮询 tick（~30s）续约到 now + 60s；
// 清扫把 lease_until < now - 30s 视为实例已死，最坏检测延迟 ~120s。
export const LEASE_TTL_MS = 60_000
export const SWEEP_GRACE_MS = 30_000
export const RETENTION_MS = 30 * 24 * 60 * 60_000

export interface Row {
  id: string
  kind: Kind
  directory: string
  user_id: string
  session_id: string
  owner_id: string
  status: Status
  payload: Record<string, unknown>
  result: Record<string, unknown> | null
  close_reason: string | null
  lease_until: number | null
  time_created: number
  time_updated: number
}

export interface NewPending {
  id: string
  kind: Kind
  directory: string
  /** 发起身份（'' = 公共/匿名）；列表与回复按此隔离租户 */
  userID: string
  sessionID: string
  ownerID: string
  payload: Record<string, unknown>
}

export interface Transition {
  status: Exclude<Status, "pending">
  result?: Record<string, unknown>
  closeReason?: CloseReason
}

export interface TransitionOutcome {
  updated?: Row
  current?: Row
}

const databaseNow = () => sql<number>`(extract(epoch from clock_timestamp()) * 1000)::bigint`

// jsonb columns decode through pgJsonb (schema.pg.ts); rows arrive parsed.
const rowify = (item: typeof HitlRequestTable.$inferSelect): Row => item as Row

// jsonb normalizes object key order on storage, so comparison must not rely on
// JSON.stringify of the raw objects.
const stableStringify = (value: unknown): string => {
  if (value === null || value === undefined) return "null"
  if (typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(",")}}`
}

export const insertPending = (input: NewPending) =>
  Database.use((db) =>
    db
      .insert(HitlRequestTable)
      .values({
        id: input.id,
        kind: input.kind,
        directory: input.directory,
        user_id: input.userID,
        session_id: input.sessionID,
        owner_id: input.ownerID,
        status: "pending",
        payload: input.payload,
        lease_until: sql`${databaseNow()} + ${LEASE_TTL_MS}`,
        time_created: databaseNow(),
        time_updated: databaseNow(),
      })
      .run(),
  )

export const insertPendingLimited = (input: NewPending, limit: number) =>
  Database.transaction(async (db) => {
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`hitl:${input.directory}:${input.sessionID}`}))`)
    const row = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(HitlRequestTable)
      .where(
        and(
          eq(HitlRequestTable.directory, input.directory),
          eq(HitlRequestTable.session_id, input.sessionID),
          eq(HitlRequestTable.status, "pending"),
        ),
      )
      .get()
    if ((row?.count ?? 0) >= limit) return false
    await insertPending(input)
    return true
  })

export async function casTransition(
  id: string,
  kind: Kind,
  directory: string,
  set: Transition,
  userID?: string,
): Promise<TransitionOutcome> {
  // userID 存在时限定归属：跨租户提交与不存在同为「查不到」（防枚举）。
  // 内部善后（salvage/cascade）不传，保持跨用户清扫能力。
  const ownerScope = userID === undefined ? [] : [eq(HitlRequestTable.user_id, userID)]
  return Database.use(async (db) => {
    const updated = await db
      .update(HitlRequestTable)
      .set({
        status: set.status,
        ...(set.result === undefined ? {} : { result: set.result }),
        ...(set.closeReason === undefined ? {} : { close_reason: set.closeReason }),
        time_updated: databaseNow(),
      })
      .where(
        and(
          eq(HitlRequestTable.id, id),
          eq(HitlRequestTable.kind, kind),
          eq(HitlRequestTable.directory, directory),
          eq(HitlRequestTable.status, "pending"),
          ...ownerScope,
        ),
      )
      .returning()
      .all()
    if (updated[0] !== undefined) return { updated: rowify(updated[0]) }
    const current = await db
      .select()
      .from(HitlRequestTable)
      .where(
        and(
          eq(HitlRequestTable.id, id),
          eq(HitlRequestTable.kind, kind),
          eq(HitlRequestTable.directory, directory),
          ...ownerScope,
        ),
      )
      .limit(1)
      .all()
    return current[0] === undefined ? {} : { current: rowify(current[0]) }
  })
}

export function renewLease(ids: string[], ownerID: string, directory: string) {
  if (ids.length === 0) return Promise.resolve()
  return Database.use((db) =>
    db
      .update(HitlRequestTable)
      .set({ lease_until: sql`${databaseNow()} + ${LEASE_TTL_MS}`, time_updated: databaseNow() })
      .where(
        and(
          inArray(HitlRequestTable.id, ids),
          eq(HitlRequestTable.owner_id, ownerID),
          eq(HitlRequestTable.directory, directory),
          eq(HitlRequestTable.status, "pending"),
        ),
      )
      .run(),
  )
}

export async function changed(ids: string[], ownerID: string, directory: string): Promise<Row[]> {
  if (ids.length === 0) return []
  return (
    await Database.use((db) =>
      db
        .select()
        .from(HitlRequestTable)
        .where(
          and(
            inArray(HitlRequestTable.id, ids),
            eq(HitlRequestTable.owner_id, ownerID),
            eq(HitlRequestTable.directory, directory),
            ne(HitlRequestTable.status, "pending"),
          ),
        )
        .all(),
    )
  ).map(rowify)
}

export async function listPending(kind: Kind, directory: string, userID: string): Promise<Row[]> {
  return (
    await Database.use((db) =>
      db
        .select()
        .from(HitlRequestTable)
        .where(
          and(
            eq(HitlRequestTable.kind, kind),
            eq(HitlRequestTable.directory, directory),
            eq(HitlRequestTable.user_id, userID),
            eq(HitlRequestTable.status, "pending"),
          ),
        )
        .all(),
    )
  ).map(rowify)
}

export async function countPending(kind: Kind, directory: string, sessionID: string): Promise<number> {
  const row = await Database.use((db) =>
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(HitlRequestTable)
      .where(
        and(
          eq(HitlRequestTable.kind, kind),
          eq(HitlRequestTable.directory, directory),
          eq(HitlRequestTable.session_id, sessionID),
          eq(HitlRequestTable.status, "pending"),
        ),
      )
      .get(),
  )
  return row?.count ?? 0
}

export async function listSessionPending(kind: Kind, directory: string, sessionID: string): Promise<Row[]> {
  return (
    await Database.use((db) =>
      db
        .select()
        .from(HitlRequestTable)
        .where(
          and(
            eq(HitlRequestTable.kind, kind),
            eq(HitlRequestTable.directory, directory),
            eq(HitlRequestTable.session_id, sessionID),
            eq(HitlRequestTable.status, "pending"),
          ),
        )
        .all(),
    )
  ).map(rowify)
}

// 死实例的挂起行：同 directory 内租约已断的 pending。
export async function deadPending(kind: Kind, directory: string): Promise<Row[]> {
  return (
    await Database.use((db) =>
      db
        .select()
        .from(HitlRequestTable)
        .where(
          and(
            eq(HitlRequestTable.kind, kind),
            eq(HitlRequestTable.directory, directory),
            eq(HitlRequestTable.status, "pending"),
            lt(HitlRequestTable.lease_until, sql`${databaseNow()} - ${SWEEP_GRACE_MS}`),
          ),
        )
        .all(),
    )
  ).map(rowify)
}

// 死实例的已决未消费行：replied/rejected 不再续约，租约断即视为原持有实例死亡
// （正常路径下 run 会很快写 part 终态，salvage 的 part CAS 不命中，仅做行归档）。
export async function deadFinal(kind: Kind, directory: string): Promise<Row[]> {
  return (
    await Database.use((db) =>
      db
        .select()
        .from(HitlRequestTable)
        .where(
          and(
            eq(HitlRequestTable.kind, kind),
            eq(HitlRequestTable.directory, directory),
            ne(HitlRequestTable.status, "pending"),
            ne(HitlRequestTable.status, "closed"),
            lt(HitlRequestTable.lease_until, sql`${databaseNow()} - ${SWEEP_GRACE_MS}`),
          ),
        )
        .all(),
    )
  ).map(rowify)
}

export function claimExpiredPending(id: string, kind: Kind, directory: string) {
  return Database.use((db) =>
    db
      .update(HitlRequestTable)
      .set({ status: "closed", close_reason: "instance-restart", time_updated: databaseNow() })
      .where(
        and(
          eq(HitlRequestTable.id, id),
          eq(HitlRequestTable.kind, kind),
          eq(HitlRequestTable.directory, directory),
          eq(HitlRequestTable.status, "pending"),
          lt(HitlRequestTable.lease_until, sql`${databaseNow()} - ${SWEEP_GRACE_MS}`),
        ),
      )
      .returning()
      .all(),
  ).then((rows) => (rows[0] === undefined ? undefined : rowify(rows[0])))
}

export function casCloseFinal(
  id: string,
  kind: Kind,
  directory: string,
  status: "replied" | "rejected",
  reason: CloseReason,
) {
  return Database.use((db) =>
    db
      .update(HitlRequestTable)
      .set({ status: "closed", close_reason: reason, time_updated: databaseNow() })
      .where(
        and(
          eq(HitlRequestTable.id, id),
          eq(HitlRequestTable.kind, kind),
          eq(HitlRequestTable.directory, directory),
          eq(HitlRequestTable.status, status),
        ),
      )
      .returning({ id: HitlRequestTable.id })
      .all(),
  )
}

export function retention(directory: string) {
  return Database.use((db) =>
    db
      .delete(HitlRequestTable)
      .where(
        and(
          eq(HitlRequestTable.directory, directory),
          ne(HitlRequestTable.status, "pending"),
          lt(HitlRequestTable.time_updated, sql`${databaseNow()} - ${RETENTION_MS}`),
        ),
      )
      .run(),
  )
}

export function sameTransition(row: Row, transition: Transition) {
  if (row.status !== transition.status) return false
  if ((row.close_reason ?? undefined) !== transition.closeReason) return false
  return stableStringify(row.result ?? undefined) === stableStringify(transition.result)
}

export * as HitlStore from "./store"
