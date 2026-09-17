import { sql } from "drizzle-orm"
import { pgTable, text, bigint, index, check } from "drizzle-orm/pg-core"
import { pgJsonb, Timestamps } from "@/storage/schema.pg"
import { SessionTable } from "@/session/session.pg"

// HITL（human-in-the-loop）挂起请求状态表：question 与 permission 共用。
// 生命周期 pending → replied/rejected/closed，全部经 CAS 迁移（见 hitl/store.ts）。
// owner_id + lease_until 构成行级租约：持有实例周期续约，租约断行的善后见 hitl/salvage.ts。
// user_id 记录发起身份：列表/回复按请求 header 的 x-user-id 过滤，租户间互不可见
// （'' 为公共/匿名，语义与 auth 个人凭据一致）。
export const HitlRequestTable = pgTable(
  "hitl_request",
  {
    id: text().primaryKey(),
    kind: text().$type<"question" | "permission">().notNull(),
    directory: text().notNull(),
    user_id: text().notNull().default(""),
    session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    owner_id: text().notNull(),
    status: text().$type<"pending" | "replied" | "rejected" | "closed">().notNull(),
    payload: pgJsonb<Record<string, unknown>>().notNull(),
    result: pgJsonb<Record<string, unknown>>(),
    close_reason: text().$type<"instance-restart" | "shutdown" | "answered-delivered" | "decision-delivered">(),
    lease_until: bigint({ mode: "number" }).notNull(),
    ...Timestamps,
  },
  (table) => [
    index("hitl_pending_idx").on(table.directory, table.user_id, table.kind, table.status, table.lease_until),
    index("hitl_session_idx").on(table.directory, table.session_id, table.status),
    index("hitl_retention_idx").on(table.status, table.time_updated),
    check("hitl_kind_check", sql`${table.kind} IN ('question', 'permission')`),
    check("hitl_status_check", sql`${table.status} IN ('pending', 'replied', 'rejected', 'closed')`),
    check(
      "hitl_close_reason_check",
      sql`${table.close_reason} IS NULL OR ${table.close_reason} IN ('instance-restart', 'shutdown', 'answered-delivered', 'decision-delivered')`,
    ),
  ],
)
