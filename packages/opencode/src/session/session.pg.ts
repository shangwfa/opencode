import { pgTable, text, bigint, jsonb, integer, real, index, primaryKey } from "drizzle-orm/pg-core"
import { ProjectTable } from "../project/project.pg"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Snapshot } from "../snapshot"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { ProjectV2 } from "@opencode-ai/core/project"
import type { SessionID, MessageID, PartID } from "./schema"
import type { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { Timestamps } from "../storage/schema.pg"

type PartData = Omit<SessionV1.Part, "id" | "sessionID" | "messageID">
type InfoData = Omit<SessionV1.Info, "id" | "sessionID">

export const SessionTable = pgTable(
  "session",
  {
    id: text().$type<SessionID>().primaryKey(),
    project_id: text()
      .$type<ProjectV2.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    workspace_id: text().$type<WorkspaceV2.ID>(),
    parent_id: text().$type<SessionID>(),
    slug: text().notNull(),
    directory: text().notNull(),
    path: text(),
    title: text().notNull(),
    version: text().notNull(),
    share_url: text(),
    summary_additions: integer(),
    summary_deletions: integer(),
    summary_files: integer(),
    summary_diffs: jsonb().$type<Snapshot.FileDiff[]>(),
    metadata: jsonb().$type<Record<string, unknown>>(),
    cost: real().notNull().default(0),
    tokens_input: integer().notNull().default(0),
    tokens_output: integer().notNull().default(0),
    tokens_reasoning: integer().notNull().default(0),
    tokens_cache_read: integer().notNull().default(0),
    tokens_cache_write: integer().notNull().default(0),
    revert: jsonb().$type<{ messageID: MessageID; partID?: PartID; snapshot?: string; diff?: string }>(),
    permission: jsonb().$type<PermissionV1.Ruleset>(),
    agent: text(),
    model: jsonb().$type<{
      id: string
      providerID: string
      variant?: string
    }>(),
    ...Timestamps,
    time_compacting: bigint({ mode: "number" }),
    time_archived: bigint({ mode: "number" }),
    pvc_mode: text().$type<"session" | "app">(),
    app_id: text(),
  },
  (table) => [
    index("session_project_idx").on(table.project_id),
    index("session_workspace_idx").on(table.workspace_id),
    index("session_parent_idx").on(table.parent_id),
  ],
)

export const MessageTable = pgTable(
  "message",
  {
    id: text().$type<MessageID>().primaryKey(),
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    ...Timestamps,
    data: jsonb().notNull().$type<InfoData>(),
  },
  (table) => [index("message_session_time_created_id_idx").on(table.session_id, table.time_created, table.id)],
)

export const PartTable = pgTable(
  "part",
  {
    id: text().$type<PartID>().primaryKey(),
    message_id: text()
      .$type<MessageID>()
      .notNull()
      .references(() => MessageTable.id, { onDelete: "cascade" }),
    session_id: text().$type<SessionID>().notNull(),
    ...Timestamps,
    data: jsonb().notNull().$type<PartData>(),
  },
  (table) => [
    index("part_message_id_id_idx").on(table.message_id, table.id),
    index("part_session_idx").on(table.session_id),
  ],
)

export const TodoTable = pgTable(
  "todo",
  {
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    content: text().notNull(),
    status: text().notNull(),
    priority: text().notNull(),
    position: integer().notNull(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.session_id, table.position] }),
    index("todo_session_idx").on(table.session_id),
  ],
)

export const SessionEntryTable = pgTable(
  "session_entry",
  {
    id: text().primaryKey(),
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    type: text().notNull(),
    ...Timestamps,
    data: jsonb().notNull(),
  },
  (table) => [
    index("session_entry_session_idx").on(table.session_id),
    index("session_entry_session_type_idx").on(table.session_id, table.type),
    index("session_entry_time_created_idx").on(table.time_created),
  ],
)

export const PermissionTable = pgTable("permission", {
  project_id: text()
    .primaryKey()
    .references(() => ProjectTable.id, { onDelete: "cascade" }),
  ...Timestamps,
  data: jsonb().notNull().$type<PermissionV1.Ruleset>(),
})
