import { pgTable, text, bigint, jsonb } from "drizzle-orm/pg-core"
import { Timestamps } from "../storage/schema.pg"
import type { ProjectV2 } from "@opencode-ai/core/project"

export const ProjectTable = pgTable("project", {
  id: text().$type<ProjectV2.ID>().primaryKey(),
  worktree: text().notNull(),
  vcs: text(),
  name: text(),
  icon_url: text(),
  icon_url_override: text(),
  icon_color: text(),
  ...Timestamps,
  time_initialized: bigint({ mode: "number" }),
  sandboxes: jsonb().notNull().$type<string[]>(),
  commands: jsonb().$type<{ start?: string }>(),
})
