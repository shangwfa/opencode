import { bigint, index, jsonb, pgTable, text } from "drizzle-orm/pg-core"

export const ClusterStateTable = pgTable("cluster_state", {
  key: text().primaryKey(),
  revision: bigint({ mode: "number" }).notNull().default(0),
  data: jsonb().$type<Record<string, unknown>>(),
  time_updated: bigint({ mode: "number" }).notNull(),
})

export const SessionAbortTable = pgTable("session_abort", {
  session_id: text().primaryKey(),
  directory: text().notNull(),
  generation: bigint({ mode: "number" }).notNull().default(1),
  time_updated: bigint({ mode: "number" }).notNull(),
})

export const ClusterBusEventTable = pgTable(
  "cluster_bus_event",
  {
    id: text().primaryKey(),
    origin: text().notNull(),
    event: jsonb().notNull().$type<Record<string, unknown>>(),
    time_created: bigint({ mode: "number" }).notNull(),
  },
  (table) => [index("cluster_bus_event_created_idx").on(table.time_created)],
)
