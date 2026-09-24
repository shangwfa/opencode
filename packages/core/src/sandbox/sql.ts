import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql.js"

export type State = "running" | "snapshotting" | "killed" | "destroyed"

export const SandboxTable = sqliteTable(
  "sandbox",
  {
    id: text().primaryKey(),
    session_id: text().notNull(),
    host: text().notNull(),
    state: text().$type<State>().notNull(),
    keep_alive: integer({ mode: "boolean" }).notNull().default(false),
    command_session_id: text(),
    ...Timestamps,
  },
  (table) => [
    uniqueIndex("sandbox_session_id_idx").on(table.session_id),
    index("sandbox_state_time_updated_idx").on(table.state, table.time_updated),
  ],
)
