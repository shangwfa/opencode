import { pgTable, text, index, uniqueIndex } from "drizzle-orm/pg-core"
import { Timestamps } from "../storage/schema.pg"
import { SessionTable } from "../session/session.pg"

export const SessionToolTable = pgTable(
  "session_tools",
  {
    id: text().primaryKey(),
    session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    name: text().notNull(),
    description: text().notNull(),
    code: text().notNull(),
    time_created: Timestamps.time_created,
    time_updated: Timestamps.time_updated,
  },
  (table) => [
    index("session_tools_session_idx").on(table.session_id),
    uniqueIndex("session_tools_session_name_idx").on(table.session_id, table.name),
  ],
)
