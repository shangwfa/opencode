import { sqliteTable, text, integer, index, primaryKey, real, uniqueIndex } from "drizzle-orm/sqlite-core"
import { sql } from "drizzle-orm"
import { directoryColumn, pathColumn } from "../database/path.js"
import { ProjectTable } from "../project/sql.js"
import type { SessionMessage } from "./message.js"
import type { SessionInbox } from "./inbox.js"
import type { FileDiff } from "@opencode/schema/file-diff"
import type { Permission } from "@opencode/schema/permission"
import type { Project } from "@opencode/schema/project"
import type { SessionSchema } from "./schema.js"
import type { Workspace } from "@opencode/schema/workspace"
import { Timestamps } from "../database/schema.sql.js"
import type { Instruction } from "@opencode/schema/instruction"
import type { Session } from "@opencode/schema/session"
import type { CompactionPayload, MovePayload, SyntheticPayload, UserPayload } from "@opencode/schema/session-inbox"
import type { RevertV1 } from "@opencode/schema/session-revert"
import type { Schema } from "effect"
import type { SessionContextInsights } from "@opencode/schema/session-context-insights"

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
type SessionMessageData = DistributiveOmit<(typeof SessionMessage.Info)["Encoded"], "type" | "id">

/**
 * Durable execution ownership for PostgreSQL SaaS: one row per Session with an
 * active turn. The lease expires by wall clock so a dead owner cannot block
 * takeover; `epoch` is the monotonic fencing token handed to the owner and
 * checked on terminal settlement, so a stale owner cannot commit results for a
 * turn another process has already taken over. Absent on SQLite, where
 * execution remains process-local.
 */
export const SessionExecutionLeaseTable = sqliteTable("session_execution_lease", {
  session_id: text()
    .$type<SessionSchema.ID>()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  owner_id: text().notNull(),
  epoch: integer().notNull(),
  time_acquired: integer().notNull(),
  time_expires: integer().notNull(),
})

/** Internal admission tombstones deliberately outlive Session deletion. */
export const SandboxExecutionGateTable = sqliteTable("sandbox_execution_gate", {
  root_session_id: text().primaryKey(),
  epoch: integer().notNull().default(1),
  state: text().$type<"open" | "closing" | "closed">().notNull().default("open"),
  sandbox_id: text(),
  time_updated: integer().notNull(),
})
export const SessionExecutionGateTable = sqliteTable("session_execution_gate", {
  session_id: text().primaryKey(),
  root_session_id: text().notNull(),
  epoch: integer().notNull().default(1),
  state: text().$type<"open" | "closing" | "closed">().notNull().default("open"),
  time_updated: integer().notNull(),
})

export const SessionTable = sqliteTable(
  "session_v2",
  {
    id: text().$type<SessionSchema.ID>().primaryKey(),
    project_id: text()
      .$type<Project.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    app_id: text().$type<SessionSchema.Info["appId"]>(),
    pvc_mode: text().$type<SessionSchema.Info["pvcMode"]>(),
    workspace_id: text().$type<Workspace.ID>(),
    parent_id: text().$type<SessionSchema.ID>(),
    fork_session_id: text().$type<SessionSchema.ID>(),
    fork_boundary: text({ mode: "json" }).$type<Session.ForkBoundary>(),
    slug: text().notNull(),
    directory: directoryColumn().notNull(),
    path: pathColumn(),
    title: text(),
    version: text().notNull(),
    share_url: text(),
    summary_additions: integer(),
    summary_deletions: integer(),
    summary_files: integer(),
    summary_diffs: text({ mode: "json" }).$type<FileDiff.LegacyInfo[]>(),
    metadata: text({ mode: "json" }).$type<Session.Metadata>(),
    sandbox: text({ mode: "json" }).$type<Session.SandboxResource>(),
    cost: real().notNull().default(0),
    tokens_input: integer().notNull().default(0),
    tokens_output: integer().notNull().default(0),
    tokens_reasoning: integer().notNull().default(0),
    tokens_cache_read: integer().notNull().default(0),
    tokens_cache_write: integer().notNull().default(0),
    revert: text({ mode: "json" }).$type<Session.Revert | RevertV1>(),
    permission: text({ mode: "json" }).$type<Permission.Ruleset>(),
    agent: text(),
    model: text({ mode: "json" }).$type<{
      id: string
      providerID: string
      variant?: string
    }>(),
    ...Timestamps,
    time_idle: integer(),
    time_viewed: integer(),
    idle_outcome: text().$type<NonNullable<Session.Info["outcome"]>>(),
    time_compacting: integer(),
    time_archived: integer(),
    /** The execution claim timestamp (historical column name; see SessionStore.claim). */
    time_suspended: integer(),
    resume_attempts: integer().notNull().default(0),
  },
  (table) => [
    index("session_v2_project_idx").on(table.project_id),
    index("session_v2_app_id_idx").on(table.app_id),
    index("session_v2_workspace_idx").on(table.workspace_id),
    index("session_v2_parent_idx").on(table.parent_id),
    index("session_v2_time_suspended_idx")
      .on(table.time_suspended)
      .where(sql`${table.time_suspended} is not null`),
  ],
)

export const SessionContextRequestTable = sqliteTable(
  "session_context_request",
  {
    id: text().$type<SessionContextInsights.RequestID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    seq: integer().notNull(),
    summary: text({ mode: "json" }).$type<SessionContextInsights.Request>().notNull(),
    items: text({ mode: "json" }).$type<ReadonlyArray<SessionContextInsights.Item>>().notNull(),
  },
  (table) => [uniqueIndex("session_context_request_session_seq_idx").on(table.session_id, table.seq)],
)

export const SessionContextContentTable = sqliteTable(
  "session_context_content",
  {
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    hash: text().notNull(),
    content: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.session_id, table.hash] })],
)

export const SessionCommandTable = sqliteTable(
  "session_commands",
  {
    id: text().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    name: text().notNull(),
    description: text(),
    template: text().notNull(),
    agent: text(),
    model: text({ mode: "json" }).$type<import("@opencode/schema/config/model").ConfigModel.Selection>(),
    subagent: integer({ mode: "boolean" }),
    hints: text({ mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    ...Timestamps,
  },
  (table) => [
    index("session_commands_session_idx").on(table.session_id),
    uniqueIndex("session_commands_session_name_idx").on(table.session_id, table.name),
  ],
)

export const SessionAgentTable = sqliteTable(
  "session_agents",
  {
    id: text().$type<import("@opencode/schema/session-agent").ID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    agent_id: text().$type<import("@opencode/schema/agent").Agent.ID>().notNull(),
    config: text({ mode: "json" }).$type<import("@opencode/schema/config/agent").ConfigAgent.Info>().notNull(),
    ...Timestamps,
  },
  (table) => [uniqueIndex("session_agents_session_agent_idx").on(table.session_id, table.agent_id)],
)

/** Durable, Session-private skill snapshots. Sandbox-discovered skills never write this table. */
export const SessionSkillTable = sqliteTable(
  "session_skills",
  {
    id: text().$type<import("@opencode/schema/session-skill").SessionSkill.ID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    skill_id: text().$type<import("@opencode/schema/skill").Skill.ID>().notNull(),
    name: text().notNull(),
    description: text(),
    autoinvoke: integer({ mode: "boolean" }),
    content: text().notNull(),
    resources: text({ mode: "json" })
      .$type<import("@opencode/schema/session-skill").SessionSkill.ResourceInput[]>()
      .notNull()
      .default(sql`'[]'`),
    ...Timestamps,
  },
  (table) => [
    index("session_skills_session_idx").on(table.session_id),
    uniqueIndex("session_skills_session_skill_idx").on(table.session_id, table.skill_id),
  ],
)

/** Durable Session-private MCP configuration; live connections are never persisted. */
export const SessionMcpTable = sqliteTable(
  "session_mcps",
  {
    id: text().$type<import("@opencode/schema/session-mcp").SessionMcp.ID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    name: text().$type<import("@opencode/schema/session-mcp").SessionMcp.Name>().notNull(),
    config: text({ mode: "json" }).$type<import("@opencode/schema/session-mcp").SessionMcp.Config>().notNull(),
    ...Timestamps,
  },
  (table) => [
    index("session_mcps_session_idx").on(table.session_id),
    uniqueIndex("session_mcps_session_name_idx").on(table.session_id, table.name),
  ],
)

/** Durable session-scoped custom tool definitions; loaded and executed at request time. */
/** Durable session-scoped plugin sources; hooks execute inside the session sandbox. */
export const SessionPluginTable = sqliteTable(
  "session_plugins",
  {
    id: text().$type<import("@opencode/schema/session-plugin").SessionPlugin.ID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    name: text().$type<import("@opencode/schema/session-plugin").SessionPlugin.Name>().notNull(),
    description: text().notNull(),
    source: text({ mode: "json" }).$type<import("@opencode/schema/session-plugin").SessionPlugin.Source>().notNull(),
    ...Timestamps,
  },
  (table) => [
    index("session_plugins_session_idx").on(table.session_id),
    uniqueIndex("session_plugins_session_name_idx").on(table.session_id, table.name),
  ],
)

export const SessionToolTable = sqliteTable(
  "session_tools",
  {
    id: text().$type<import("@opencode/schema/session-tool").SessionTool.ID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    name: text().$type<import("@opencode/schema/session-tool").SessionTool.Name>().notNull(),
    description: text().notNull(),
    code: text().notNull(),
    ...Timestamps,
  },
  (table) => [
    index("session_tools_session_idx").on(table.session_id),
    uniqueIndex("session_tools_session_name_idx").on(table.session_id, table.name),
  ],
)

export const SessionAgentsMdTable = sqliteTable(
  "session_agents_md",
  {
    id: text().$type<import("@opencode/schema/session-agents-md").SessionAgentsMd.ID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    content: text().notNull(),
    ...Timestamps,
  },
  (table) => [
    // The unique index already serves session_id lookups; a second plain index is redundant.
    uniqueIndex("session_agents_md_session_unique_idx").on(table.session_id),
  ],
)

export const SessionMessageTable = sqliteTable(
  "session_message",
  {
    id: text().$type<SessionMessage.ID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    type: text().$type<SessionMessage.Type>().notNull(),
    seq: integer().notNull(),
    ...Timestamps,
    data: text({ mode: "json" }).notNull().$type<SessionMessageData>(),
  },
  (table) => [
    uniqueIndex("session_message_session_seq_idx").on(table.session_id, table.seq),
    index("session_message_session_type_seq_idx").on(table.session_id, table.type, table.seq),
    index("session_message_session_time_created_id_idx").on(table.session_id, table.time_created, table.id),
    index("session_message_time_created_idx").on(table.time_created),
  ],
)

export const SessionPendingTable = sqliteTable(
  "session_pending",
  {
    id: text().$type<SessionMessage.ID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    type: text().$type<SessionInbox.Info["type"]>().notNull(),
    data: text({ mode: "json" }).$type<UserPayload | SyntheticPayload | Record<string, never>>().notNull(),
    delivery: text().$type<SessionInbox.Delivery>(),
    admitted_seq: integer().notNull(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    index("session_pending_session_delivery_seq_idx").on(table.session_id, table.delivery, table.admitted_seq),
    uniqueIndex("session_pending_session_compaction_idx")
      .on(table.session_id)
      .where(sql`${table.type} = 'compaction'`),
    uniqueIndex("session_pending_session_admitted_seq_idx").on(table.session_id, table.admitted_seq),
  ],
)

export const SessionInboxTable = sqliteTable(
  "session_inbox",
  {
    id: text().$type<SessionMessage.ID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    type: text().$type<SessionInbox.Info["type"]>().notNull(),
    payload: text({ mode: "json" }).$type<UserPayload | SyntheticPayload | CompactionPayload | MovePayload>().notNull(),
    delivery: text().$type<SessionInbox.Delivery>().notNull(),
    enqueued_seq: integer().notNull(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    index("session_inbox_session_delivery_seq_idx").on(table.session_id, table.delivery, table.enqueued_seq),
    uniqueIndex("session_inbox_session_enqueued_seq_idx").on(table.session_id, table.enqueued_seq),
  ],
)

export const InstructionEntryTable = sqliteTable(
  "instruction_entry",
  {
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    key: text().notNull(),
    value: text({ mode: "json" }).$type<Schema.Json>(),
    removed: integer({ mode: "boolean" }).notNull().default(false),
    ...Timestamps,
  },
  (table) => [primaryKey({ columns: [table.session_id, table.key] })],
)

export const InstructionBlobTable = sqliteTable("instruction_blob", {
  hash: text().$type<Instruction.Hash>().primaryKey(),
  value: text({ mode: "json" }).$type<Schema.Json>(),
})

export const InstructionStateTable = sqliteTable("instruction_state", {
  session_id: text()
    .$type<SessionSchema.ID>()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  epoch_start: integer().notNull(),
  through_seq: integer().notNull(),
  initial_values: text({ mode: "json" }).notNull().$type<Instruction.Values>(),
  current_values: text({ mode: "json" }).notNull().$type<Instruction.Values>(),
})
