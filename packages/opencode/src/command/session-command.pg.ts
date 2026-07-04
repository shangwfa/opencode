import { pgTable, text, boolean, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core"
import { Timestamps } from "../storage/schema.pg"
import { SessionTable } from "../session/session.pg"

export const SessionCommandTable = pgTable(
  "session_commands",
  {
    id: text().primaryKey(),
    session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    name: text().notNull(),
    description: text(),
    template: text().notNull(),
    agent: text(),
    model: text(),
    subtask: boolean(),
    hints: jsonb().notNull().$type<string[]>().default([]),
    time_created: Timestamps.time_created,
    time_updated: Timestamps.time_updated,
  },
  (table) => [
    index("session_commands_session_idx").on(table.session_id),
    uniqueIndex("session_commands_session_name_idx").on(table.session_id, table.name),
  ],
)
