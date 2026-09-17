import { pgTable, text, boolean, index, uniqueIndex } from "drizzle-orm/pg-core"
import { Timestamps } from "../storage/schema.pg"
import { SessionTable } from "../session/session.pg"

export const SessionPluginTable = pgTable(
  "session_plugins",
  {
    id: text().primaryKey(),
    session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    name: text().notNull(),
    description: text(),
    source: text().notNull().default("code"),
    spec: text(),
    code: text().notNull().default(""),
    enabled: boolean().notNull().default(true),
    time_created: Timestamps.time_created,
    time_updated: Timestamps.time_updated,
  },
  (table) => [
    index("session_plugins_session_idx").on(table.session_id),
    uniqueIndex("session_plugins_session_name_idx").on(table.session_id, table.name),
  ],
)
