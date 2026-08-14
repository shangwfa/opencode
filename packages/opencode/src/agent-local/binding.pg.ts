import { pgTable, text, bigint } from "drizzle-orm/pg-core"

export const LocalAgentBindingTable = pgTable("local_agent_binding", {
  session_id: text().primaryKey(),
  agent_id: text().notNull(),
  time_created: bigint({ mode: "number" }).notNull(),
  time_updated: bigint({ mode: "number" }).notNull(),
})

export * as LocalAgentBinding from "./binding.pg"
