import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { Project } from "@opencode/schema/project"
import { Timestamps } from "../database/schema.sql.js"
import { ProjectTable } from "../project/sql.js"
import type { PermissionSaved } from "./saved.js"
import type { SessionPermissionApproval } from "@opencode/schema/session-permission-approval"
import type { Session } from "@opencode/schema/session"
import type { Permission } from "@opencode/schema/permission"
import { SessionTable } from "../session/sql.js"

export const PermissionTable = sqliteTable(
  "permission",
  {
    id: text().$type<PermissionSaved.ID>().primaryKey(),
    project_id: text()
      .$type<Project.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    action: text().notNull(),
    resource: text().notNull(),
    ...Timestamps,
  },
  (table) => [uniqueIndex("permission_project_action_resource_idx").on(table.project_id, table.action, table.resource)],
)

export const SessionPermissionApprovalTable = sqliteTable(
  "session_permission_approval",
  {
    id: text().$type<SessionPermissionApproval.ID>().primaryKey(),
    session_id: text()
      .$type<Session.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    action: text().notNull(),
    resource: text().notNull(),
    // Audit reference, not an FK: request retention must not revoke approval.
    source_request_id: text().$type<Permission.ID>(),
    ...Timestamps,
  },
  (table) => [uniqueIndex("session_permission_approval_scope_idx").on(table.session_id, table.action, table.resource)],
)
