import { pgTable, text, uniqueIndex } from "drizzle-orm/pg-core"
import { Timestamps } from "../storage/schema.pg"
import { SessionTable } from "./session.pg"

export const SessionAgentsMdTable = pgTable(
  "session_agents_md",
  {
    id: text().primaryKey(),
    session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    content: text().notNull(),
    time_created: Timestamps.time_created,
    time_updated: Timestamps.time_updated,
  },
  (table) => [uniqueIndex("session_agents_md_session_idx").on(table.session_id)],
)
