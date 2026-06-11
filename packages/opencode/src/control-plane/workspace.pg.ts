import { pgTable, text, jsonb, bigint } from "drizzle-orm/pg-core"
import { ProjectTable } from "../project/project.pg"
import type { ProjectV2 } from "@opencode-ai/core/project"
import type { WorkspaceV2 } from "@opencode-ai/core/workspace"

export const WorkspaceTable = pgTable("workspace", {
  id: text().$type<WorkspaceV2.ID>().primaryKey(),
  type: text().notNull(),
  name: text().notNull().default(""),
  branch: text(),
  directory: text(),
  extra: jsonb(),
  project_id: text()
    .$type<ProjectV2.ID>()
    .notNull()
    .references(() => ProjectTable.id, { onDelete: "cascade" }),
  time_used: bigint({ mode: "number" }),
})
