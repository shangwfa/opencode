import { pgTable, text, boolean, index } from "drizzle-orm/pg-core"
import { Timestamps } from "../storage/schema.pg"

export const SandboxTable = pgTable(
  "sandbox",
  {
    id: text().primaryKey(),
    session_id: text().notNull().unique(),
    host: text().notNull(),
    state: text().$type<"running" | "killed" | "destroyed">().notNull(),
    keep_alive: boolean().notNull().default(false),
    command_session_id: text(),
    ...Timestamps,
  },
  (table) => [index("sandbox_reap_idx").on(table.state, table.keep_alive, table.time_updated)],
)
