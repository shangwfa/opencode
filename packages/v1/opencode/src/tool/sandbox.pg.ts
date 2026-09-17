import { pgTable, text, boolean } from "drizzle-orm/pg-core"
import { Timestamps } from "../storage/schema.pg"

export const SandboxTable = pgTable("sandbox", {
  id: text().primaryKey(),
  session_id: text().notNull().unique(),
  host: text().notNull(),
  state: text().$type<"running" | "snapshotting" | "killed" | "destroyed">().notNull(),
  keep_alive: boolean().notNull().default(false),
  command_session_id: text(),
  ...Timestamps,
})
