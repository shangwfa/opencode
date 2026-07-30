import { pgTable, text, index, uniqueIndex, jsonb } from "drizzle-orm/pg-core"
import { Timestamps } from "../storage/schema.pg"
import { SessionTable } from "../session/session.pg"
import type { SkillResource } from "./resource"

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

export const SessionSkillTable = pgTable(
  "session_skill",
  {
    id: text().primaryKey(),
    session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    name: text().notNull(),
    description: text().notNull(),
    content: text().notNull(),
    resources: jsonb().notNull().$type<SkillResource.Stored[]>().default([]),
    time_created: Timestamps.time_created,
    time_updated: Timestamps.time_updated,
  },
  (table) => [
    index("session_skill_session_idx").on(table.session_id),
    uniqueIndex("session_skill_session_name_idx").on(table.session_id, table.name),
  ],
)
