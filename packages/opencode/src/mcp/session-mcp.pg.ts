import { pgTable, text, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core"
import { Timestamps } from "../storage/schema.pg"
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
    command: jsonb().$type<string[]>(),
    url: text(),
    environment: jsonb().notNull().$type<Record<string, string>>().default({}),
    headers: jsonb().notNull().$type<Record<string, string>>().default({}),
    enabled: jsonb().notNull().$type<boolean>().default(true),
    time_created: Timestamps.time_created,
    time_updated: Timestamps.time_updated,
  },
  (table) => [
    index("session_mcps_session_idx").on(table.session_id),
    uniqueIndex("session_mcps_session_name_idx").on(table.session_id, table.name),
  ],
)
