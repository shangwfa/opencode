import { sqliteTable, text, index } from "drizzle-orm/sqlite-core"
import type { SessionSchema } from "../session/schema.js"
import { SessionTable } from "../session/sql.js"
import { Timestamps } from "../database/schema.sql.js"

/**
 * Durable HITL ledger for PostgreSQL SaaS: one row per Form/Permission request
 * owned by a real Session. Pending rows survive process death and are visible
 * to every pod; the decision columns are the authority for who may settle a
 * request and with what result. The MCP elicitation "global" owner and SQLite
 * deployments never write this table.
 */
export const HitlRequestTable = sqliteTable(
  "hitl_request",
  {
    id: text().primaryKey(),
    kind: text().$type<"form" | "permission">().notNull(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    payload: text({ mode: "json" }).notNull(),
    decision: text()
      .$type<"pending" | "answered" | "cancelled" | "approved" | "rejected">()
      .notNull()
      .default("pending"),
    result: text({ mode: "json" }),
    ...Timestamps,
  },
  (table) => [
    index("hitl_request_session_pending_idx").on(table.session_id, table.decision),
    index("hitl_request_decision_idx").on(table.decision),
  ],
)
