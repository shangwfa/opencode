import { pgTable, text, bigint, jsonb, index } from "drizzle-orm/pg-core"
import { Timestamps } from "@/storage/schema.pg"

// HITL（human-in-the-loop）挂起请求状态表：question 与 permission 共用。
// 生命周期 pending → replied/rejected/closed，全部经 CAS 迁移（见 hitl/store.ts）。
// owner_id + lease_until 构成行级租约：持有实例周期续约，租约断行的善后见 hitl/salvage.ts。
export const HitlRequestTable = pgTable(
  "hitl_request",
  {
    id: text().primaryKey(),
    kind: text().$type<"question" | "permission">().notNull(),
    directory: text().notNull(),
    session_id: text().notNull(),
    owner_id: text().notNull(),
    status: text().$type<"pending" | "replied" | "rejected" | "closed">().notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    result: jsonb().$type<Record<string, unknown>>(),
    close_reason: text().$type<"instance-restart" | "shutdown" | "answered-delivered">(),
    lease_until: bigint({ mode: "number" }),
    ...Timestamps,
  },
  (table) => [
    index("hitl_pending_idx").on(table.status, table.lease_until),
    index("hitl_session_idx").on(table.session_id),
  ],
)
