import { pgTable, text, bigint, jsonb } from "drizzle-orm/pg-core"
import { Timestamps } from "../storage/schema.pg"
import type { ProjectID } from "./schema"

export const ProjectTable = pgTable("project", {
  id: text().$type<ProjectID>().primaryKey(),
  worktree: text().notNull(),
  vcs: text(),
  name: text(),
  icon_url: text(),
  icon_color: text(),
  ...Timestamps,
  time_initialized: bigint({ mode: "number" }),
  sandboxes: jsonb().notNull().$type<string[]>(),
  commands: jsonb().$type<{ start?: string }>(),
})
