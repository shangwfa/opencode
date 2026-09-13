// hitl_request 表的持久化操作。仅在 PG 模式生效（enabled()）；SQLite 模式下
// question/permission service 退回纯内存行为（上游单机语义）。
// 所有状态迁移都是 CAS（WHERE status = 'pending'），天然幂等；返回 outcome 让
// 调用方区分「本次迁移成功」与「行已终态」（跨实例迟到/重复提交）。
import { and, eq, inArray, lt, ne, sql } from "drizzle-orm"
import { Database } from "@/storage/db"
import { HitlRequestTable } from "./request.pg"

export type Kind = "question" | "permission"
export type Status = "pending" | "replied" | "rejected" | "closed"
export type CloseReason = "instance-restart" | "shutdown" | "answered-delivered"

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
  sessionID: string
  ownerID: string
  payload: Record<string, unknown>
  leaseUntil: number
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

const now = () => Date.now()

const rowify = (item: typeof HitlRequestTable.$inferSelect): Row => item as Row

export const insertPending = (input: NewPending) =>
  Database.Client()
    .insert(HitlRequestTable)
    .values({
      id: input.id,
      kind: input.kind,
      directory: input.directory,
      session_id: input.sessionID,
      owner_id: input.ownerID,
      status: "pending",
      payload: input.payload,
      lease_until: input.leaseUntil,
      time_created: now(),
      time_updated: now(),
    })
    .run()

export async function casTransition(id: string, kind: Kind, set: Transition): Promise<TransitionOutcome> {
  const db = Database.Client()
  const updated = await db
    .update(HitlRequestTable)
    .set({
      status: set.status,
      ...(set.result === undefined ? {} : { result: set.result }),
      ...(set.closeReason === undefined ? {} : { close_reason: set.closeReason }),
      time_updated: now(),
    })
    .where(and(eq(HitlRequestTable.id, id), eq(HitlRequestTable.kind, kind), eq(HitlRequestTable.status, "pending")))
    .returning()
    .all()
  if (updated[0] !== undefined) return { updated: rowify(updated[0]) }
  const current = await db.select().from(HitlRequestTable).where(eq(HitlRequestTable.id, id)).limit(1).all()
  return current[0] === undefined ? {} : { current: rowify(current[0]) }
}

export function renewLease(ids: string[], until: number) {
  if (ids.length === 0) return Promise.resolve()
  return Database.Client()
    .update(HitlRequestTable)
    .set({ lease_until: until, time_updated: now() })
    .where(and(inArray(HitlRequestTable.id, ids), eq(HitlRequestTable.status, "pending")))
    .run()
}

export async function changed(ids: string[]): Promise<Row[]> {
  if (ids.length === 0) return []
  return (
    await Database.Client()
      .select()
      .from(HitlRequestTable)
      .where(and(inArray(HitlRequestTable.id, ids), ne(HitlRequestTable.status, "pending")))
      .all()
  ).map(rowify)
}

export async function listPending(kind: Kind, directory: string): Promise<Row[]> {
  return (
    await Database.Client()
      .select()
      .from(HitlRequestTable)
      .where(
        and(eq(HitlRequestTable.kind, kind), eq(HitlRequestTable.directory, directory), eq(HitlRequestTable.status, "pending")),
      )
      .all()
  ).map(rowify)
}

export async function countPending(kind: Kind, sessionID: string): Promise<number> {
  const row = await Database.Client()
    .select({ count: sql<number>`count(*)::int` })
    .from(HitlRequestTable)
    .where(and(eq(HitlRequestTable.kind, kind), eq(HitlRequestTable.session_id, sessionID), eq(HitlRequestTable.status, "pending")))
    .get()
  return row?.count ?? 0
}

// 死实例的挂起行：同 directory 内租约已断的 pending。
export async function deadPending(kind: Kind, directory: string, before: number): Promise<Row[]> {
  return (
    await Database.Client()
      .select()
      .from(HitlRequestTable)
      .where(
        and(
          eq(HitlRequestTable.kind, kind),
          eq(HitlRequestTable.directory, directory),
          eq(HitlRequestTable.status, "pending"),
          lt(HitlRequestTable.lease_until, before),
        ),
      )
      .all()
  ).map(rowify)
}

// 死实例的已决未消费行：replied/rejected 不再续约，租约断即视为原持有实例死亡
// （正常路径下 run 会很快写 part 终态，salvage 的 part CAS 不命中，仅做行归档）。
export async function deadFinal(kind: Kind, directory: string, before: number): Promise<Row[]> {
  return (
    await Database.Client()
      .select()
      .from(HitlRequestTable)
      .where(
        and(
          eq(HitlRequestTable.kind, kind),
          eq(HitlRequestTable.directory, directory),
          ne(HitlRequestTable.status, "pending"),
          ne(HitlRequestTable.status, "closed"),
          lt(HitlRequestTable.lease_until, before),
        ),
      )
      .all()
  ).map(rowify)
}

export function casCloseReplied(id: string, reason: CloseReason) {
  return Database.Client()
    .update(HitlRequestTable)
    .set({ status: "closed", close_reason: reason, time_updated: now() })
    .where(and(eq(HitlRequestTable.id, id), eq(HitlRequestTable.status, "replied")))
    .returning({ id: HitlRequestTable.id })
    .all()
}

export function retention(before: number) {
  return Database.Client()
    .delete(HitlRequestTable)
    .where(and(ne(HitlRequestTable.status, "pending"), lt(HitlRequestTable.time_updated, before)))
    .run()
}

export * as HitlStore from "./store"
