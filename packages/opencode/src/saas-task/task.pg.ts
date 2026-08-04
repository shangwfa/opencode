import { sql } from "drizzle-orm"
import { bigint, jsonb, pgTable, text, index } from "drizzle-orm/pg-core"
import { Timestamps } from "../storage/schema.pg"

export const SaasTaskTable = pgTable(
  "saas_task",
  {
    id: text().primaryKey(),
    title: text().notNull(),
    description: text().notNull().default(""),
    project_ids: jsonb().notNull().$type<string[]>().default([]),
    metadata: jsonb().notNull().$type<Record<string, unknown>>().default({}),
    time_created: Timestamps.time_created,
    time_updated: Timestamps.time_updated,
  },
  (table) => [index("saas_task_time_idx").on(table.time_created)],
)
