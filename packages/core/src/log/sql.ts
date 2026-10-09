import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { SessionTable } from "../session/sql.js"
import type { SessionSchema } from "../session/schema.js"

/**
 * Session-scoped write-audit log for control-plane operations (V1 `exec_log`
 * successor). Rows cascade with their Session, matching the V1 cleanup contract.
 */
export const LogTable = sqliteTable(
  "log",
  {
    id: text().$type<import("@opencode/schema/log").Log.ID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    source: text().$type<import("@opencode/schema/log").Log.Source>().notNull(),
    detail: text({ mode: "json" }).$type<Record<string, unknown>>(),
    // NULL unless the audited operation ran inside an exported OTLP trace.
    trace_id: text().$type<string>(),
    time_created: integer().notNull(),
  },
  (table) => [index("log_session_time_idx").on(table.session_id, table.time_created)],
)
