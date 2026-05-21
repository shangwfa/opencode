import { pgTable, text, integer, real, index, uniqueIndex, jsonb } from "drizzle-orm/pg-core"
import { Timestamps } from "../storage/schema.pg"
import { SessionTable } from "../session/session.pg"

export const SessionAgentTable = pgTable(
  "session_agents",
  {
    id: text().primaryKey(),
    session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    name: text().notNull(),
    description: text(),
    mode: text().notNull().default("all"),
    prompt: text(),
    permission: jsonb()
      .notNull()
      .$type<
        Array<{
          permission: string
          pattern: string
          action: "allow" | "deny" | "ask"
        }>
      >()
      .default([]),
    model: jsonb().$type<{ providerID: string; modelID: string }>(),
    temperature: real(),
    top_p: real(),
    steps: integer(),
    color: text(),
    variant: text(),
    options: jsonb().notNull().$type<Record<string, unknown>>().default({}),
    time_created: Timestamps.time_created,
    time_updated: Timestamps.time_updated,
  },
  (table) => [
    index("session_agents_session_idx").on(table.session_id),
    uniqueIndex("session_agents_session_name_idx").on(table.session_id, table.name),
  ],
)
