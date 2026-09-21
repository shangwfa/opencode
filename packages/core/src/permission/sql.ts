import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { Project } from "@opencode/schema/project"
import { Timestamps } from "../database/schema.sql.js"
import { ProjectTable } from "../project/sql.js"
import type { PermissionSaved } from "./saved.js"

export const PermissionTable = sqliteTable(
  "permission",
  {
    id: text().$type<PermissionSaved.ID>().primaryKey(),
    project_id: text()
      .$type<Project.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    user_id: text().notNull().default(""),
    action: text().notNull(),
    resource: text().notNull(),
    ...Timestamps,
  },
  (table) => [
    uniqueIndex("permission_project_user_action_resource_idx").on(
      table.project_id,
      table.user_id,
      table.action,
      table.resource,
    ),
  ],
)
