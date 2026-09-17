import { pgTable, text, index, uniqueIndex } from "drizzle-orm/pg-core"
import { pgJsonb, Timestamps } from "../storage/schema.pg"
import { SessionTable } from "../session/session.pg"

export const SessionMcpTable = pgTable(
  "session_mcps",
  {
    id: text().primaryKey(),
    session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    name: text().notNull(),
    type: text().notNull(),
    command: pgJsonb<string[]>(),
    url: text(),
    environment: pgJsonb<Record<string, string>>().notNull().default({}),
    headers: pgJsonb<Record<string, string>>().notNull().default({}),
    enabled: pgJsonb<boolean>().notNull().default(true),
    time_created: Timestamps.time_created,
    time_updated: Timestamps.time_updated,
  },
  (table) => [
    index("session_mcps_session_idx").on(table.session_id),
    uniqueIndex("session_mcps_session_name_idx").on(table.session_id, table.name),
  ],
)
