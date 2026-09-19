import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { Session } from "@opencode/schema/session"
import { SessionTable as SessionSqlTable } from "../session/sql.js"
import { Timestamps } from "../database/schema.sql.js"

/**
 * HITL pending-request state, schema-compatible with the v1 fleet's
 * `hitl_request` table (see feat/opencode-1.18.31 packages/opencode/src/hitl/
 * request.pg.ts): identical table name, columns, enums, and indexes, so v2
 * writes rows the v1 tooling can read and existing data carries over.
 * kind="question" covers v2's form-based questions; kind="permission" covers
 * permission asks. pending → replied/rejected/closed all via CAS.
 */
export const HitlRequestTable = sqliteTable(
  "hitl_request",
  {
    id: text().primaryKey(),
    kind: text().$type<"question" | "permission">().notNull(),
    directory: text().notNull(),
    user_id: text().notNull().default(""),
    session_id: text()
      // Plain string: form session ids include the "global" elicitation escape
      // hatch, which is not a branded SessionID.
      .notNull()
      .references(() => SessionSqlTable.id, { onDelete: "cascade" }),
    owner_id: text().notNull(),
    status: text().$type<"pending" | "replied" | "rejected" | "closed">().notNull(),
    payload: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    result: text({ mode: "json" }).$type<Record<string, unknown>>(),
    close_reason: text().$type<
      "instance-restart" | "shutdown" | "answered-delivered" | "decision-delivered"
    >(),
    lease_until: integer().notNull(),
    ...Timestamps,
  },
  (table) => [
    index("hitl_pending_idx").on(table.directory, table.user_id, table.kind, table.status, table.lease_until),
    index("hitl_session_idx").on(table.directory, table.session_id, table.status),
    index("hitl_retention_idx").on(table.status, table.time_updated),
  ],
)
