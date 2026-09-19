import { sqliteTable, text, index, uniqueIndex } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../storage/schema.pg"

export const UserSkillTable = sqliteTable(
  "user_skill",
  {
    id: text().primaryKey(),
    user_id: text().notNull(),
    name: text().notNull(),
    description: text().notNull(),
    content: text().notNull(),
    ...Timestamps,
  },
  (table) => [
    index("user_skill_user_idx").on(table.user_id),
    uniqueIndex("user_skill_user_name_idx").on(table.user_id, table.name),
  ],
)
