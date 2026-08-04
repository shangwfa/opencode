import { bigint, boolean, integer, jsonb, pgTable, text, index } from "drizzle-orm/pg-core"
import { Timestamps } from "../storage/schema.pg"

export const ScheduleTable = pgTable(
  "schedule",
  {
    id: text().primaryKey(),
    owner_type: text().notNull(),
    owner_id: text().notNull(),
    cron: text().notNull(),
    enabled: boolean().notNull().default(true),
    payload: jsonb().notNull().$type<Record<string, unknown>>().default({}),
    last_run_at: bigint({ mode: "number" }),
    next_run_at: bigint({ mode: "number" }),
    run_count: integer().notNull().default(0),
    last_error: text(),
    time_created: Timestamps.time_created,
    time_updated: Timestamps.time_updated,
  },
  (table) => [
    index("schedule_next_run_idx").on(table.next_run_at),
    index("schedule_owner_idx").on(table.owner_type, table.owner_id),
  ],
)
