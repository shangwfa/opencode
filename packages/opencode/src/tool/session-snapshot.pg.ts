import { pgTable, text, integer, bigint, index, uniqueIndex } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import { Timestamps } from "../storage/schema.pg"

export const SessionSnapshotTable = pgTable(
  "session_snapshot",
  {
    id: text().primaryKey(),
    session_id: text(),
    app_id: text(),
    scope: text().$type<"session" | "baseline">().notNull(),
    state: text().$type<"creating" | "ready" | "failed" | "stale" | "deleting" | "deleted">().notNull(),
    reason: text(),
    // 兼容性/血缘元数据：创建快照时的镜像与会话沙箱（恢复前校验镜像漂移，排障溯源）
    image: text(),
    source_sandbox_id: text(),
    // 恢复前兼容性校验：arch 跨架构、schema_version 快照内容布局版本、runtime_version opencode 版本
    arch: text(),
    schema_version: integer(),
    runtime_version: text(),
    restored_count: integer().notNull().default(0),
    last_restored_at: bigint({ mode: "number" }),
    ...Timestamps,
  },
  (t) => [index("session_snapshot_session_idx").on(t.session_id, t.state), index("session_snapshot_app_idx").on(t.app_id, t.scope)],
)

/** 快照编排操作（durable job）：kill/回收触发的快照销毁流程先落库再由 worker 领取执行，
 * 进程重启后其他实例可凭租约过期接管；attempts/next_retry_at 提供退避与上限。 */
export const SnapshotOperationTable = pgTable(
  "snapshot_operation",
  {
    id: text().primaryKey(),
    session_id: text().notNull(),
    sandbox_id: text(),
    kind: text().$type<"snapshot_destroy">().notNull(),
    state: text().$type<"pending" | "running" | "done" | "failed">().notNull(),
    attempts: integer().notNull().default(0),
    next_retry_at: bigint({ mode: "number" }),
    lease_owner: text(),
    lease_until: bigint({ mode: "number" }),
    // 每次领取单调递增；执行体写状态/续租都需带上，防止租约过期被接管后旧执行者覆盖新状态
    fencing_token: bigint({ mode: "number" }).notNull().default(0),
    error: text(),
    ...Timestamps,
  },
  (t) => [
    index("snapshot_operation_claim_idx").on(t.state, t.next_retry_at),
    index("snapshot_operation_session_idx").on(t.session_id, t.time_created),
    // 同 session+sandbox+kind 至多一条活跃操作；sandbox_id 为 NULL 时不去重（Postgres NULL distinct），destroy 路径恒非空
    uniqueIndex("snapshot_operation_active_uniq")
      .on(t.session_id, t.sandbox_id, t.kind)
      .where(sql`${t.state} in ('pending', 'running')`),
  ],
)
