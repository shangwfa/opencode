import { pgTable, text, index, uniqueIndex } from "drizzle-orm/pg-core"
import { Timestamps } from "../storage/schema.pg"

export const UserSkillTable = pgTable(
  "user_skill",
  {
    id: text().primaryKey(),
    user_id: text().notNull(),
    name: text().notNull(),
    description: text().notNull(),
    content: text().notNull(),
    time_created: Timestamps.time_created,
    time_updated: Timestamps.time_updated,
  },
  (table) => [
    index("user_skill_user_idx").on(table.user_id),
    uniqueIndex("user_skill_user_name_idx").on(table.user_id, table.name),
  ],
)
