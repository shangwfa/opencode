import { sql } from "drizzle-orm"
import { bigint, boolean, check, index, jsonb, pgTable, real, text, uniqueIndex } from "drizzle-orm/pg-core"
import { Timestamps } from "../storage/schema.pg"

export type SecretEnvelope = {
  algorithm: "aes-256-gcm"
  keyID: string
  nonce: string
  ciphertext: string
  tag: string
}

export const SaasProjectTable = pgTable(
  "saas_project",
  {
    id: text().primaryKey(),
    name: text().notNull(),
    description: text().notNull().default(""),
    status: text().notNull().default("active"),
    repository_provider: text().notNull(),
    repository_url: text().notNull(),
    repository_host: text().notNull(),
    repository_path: text().notNull(),
    repository_default_branch: text(),
    repository_auth_type: text().notNull(),
    repository_credential: jsonb().$type<SecretEnvelope>(),
    repository_verified_at: bigint({ mode: "number" }).notNull(),
    repository_last_checked_at: bigint({ mode: "number" }).notNull(),
    repository_connection_status: text().notNull().default("verified"),
    metadata: jsonb().notNull().$type<Record<string, unknown>>().default({}),
    time_created: Timestamps.time_created,
    time_updated: Timestamps.time_updated,
    time_archived: bigint({ mode: "number" }),
  },
  (table) => [
    index("saas_project_status_idx").on(table.status),
    index("saas_project_repository_host_idx").on(table.repository_host),
    check("saas_project_status_check", sql`${table.status} IN ('active', 'archived')`),
    check(
      "saas_project_repository_provider_check",
      sql`${table.repository_provider} IN ('github', 'gitlab', 'generic')`,
    ),
    check(
      "saas_project_repository_auth_type_check",
      sql`${table.repository_auth_type} IN ('none', 'oauth', 'token', 'basic', 'ssh')`,
    ),
    check(
      "saas_project_repository_connection_status_check",
      sql`${table.repository_connection_status} IN ('verified', 'unreachable', 'unauthorized')`,
    ),
  ],
)

export const AgentTable = pgTable(
  "agent",
  {
    id: text().primaryKey(),
    project_id: text().notNull(),
    name: text().notNull(),
    description: text(),
    mode: text().notNull().default("all"),
    prompt: text(),
    permission: jsonb()
      .notNull()
      .$type<Array<{ permission: string; pattern: string; action: "allow" | "deny" | "ask" }>>()
      .default([]),
    model: jsonb().$type<{ providerID: string; modelID: string }>(),
    temperature: real(),
    top_p: real(),
    steps: bigint({ mode: "number" }),
    color: text(),
    variant: text(),
    options: jsonb().notNull().$type<Record<string, unknown>>().default({}),
    time_created: Timestamps.time_created,
    time_updated: Timestamps.time_updated,
  },
  (table) => [
    index("agent_project_idx").on(table.project_id),
    uniqueIndex("agent_project_name_idx").on(table.project_id, table.name),
    check("agent_mode_check", sql`${table.mode} IN ('primary', 'subagent', 'all')`),
  ],
)

export const SkillTable = pgTable(
  "skill",
  {
    id: text().primaryKey(),
    project_id: text().notNull(),
    name: text().notNull(),
    description: text().notNull(),
    content: text().notNull(),
    resources: jsonb()
      .notNull()
      .$type<Array<{ path: string; type: string; content: string; size: number }>>()
      .default([]),
    time_created: Timestamps.time_created,
    time_updated: Timestamps.time_updated,
  },
  (table) => [
    index("skill_project_idx").on(table.project_id),
    uniqueIndex("skill_project_name_idx").on(table.project_id, table.name),
  ],
)

export const McpTable = pgTable(
  "mcp",
  {
    id: text().primaryKey(),
    project_id: text().notNull(),
    name: text().notNull(),
    type: text().notNull(),
    command: jsonb().$type<string[]>(),
    url: text(),
    enabled: boolean().notNull().default(true),
    timeout: bigint({ mode: "number" }),
    environment_keys: jsonb().notNull().$type<string[]>().default([]),
    header_keys: jsonb().notNull().$type<string[]>().default([]),
    secrets: jsonb().$type<SecretEnvelope>(),
    time_created: Timestamps.time_created,
    time_updated: Timestamps.time_updated,
  },
  (table) => [
    index("mcp_project_idx").on(table.project_id),
    uniqueIndex("mcp_project_name_idx").on(table.project_id, table.name),
    check("mcp_type_check", sql`${table.type} IN ('local', 'remote')`),
    check(
      "mcp_transport_check",
      sql`(${table.type} = 'local' AND ${table.command} IS NOT NULL AND ${table.url} IS NULL) OR (${table.type} = 'remote' AND ${table.command} IS NULL AND ${table.url} IS NOT NULL)`,
    ),
  ],
)

export const ProjectAgentsMdTable = pgTable(
  "project_agents_md",
  {
    id: text().primaryKey(),
    project_id: text().notNull(),
    content: text().notNull(),
    time_created: Timestamps.time_created,
    time_updated: Timestamps.time_updated,
  },
  (table) => [uniqueIndex("project_agents_md_project_idx").on(table.project_id)],
)

export const ProjectCommandTable = pgTable(
  "project_command",
  {
    id: text().primaryKey(),
    project_id: text().notNull(),
    name: text().notNull(),
    description: text(),
    template: text().notNull(),
    agent: text(),
    model: text(),
    subtask: boolean(),
    hints: jsonb().notNull().$type<string[]>().default([]),
    time_created: Timestamps.time_created,
    time_updated: Timestamps.time_updated,
  },
  (table) => [
    index("project_command_project_idx").on(table.project_id),
    uniqueIndex("project_command_project_name_idx").on(table.project_id, table.name),
  ],
)

export const ProjectToolTable = pgTable(
  "project_tool",
  {
    id: text().primaryKey(),
    project_id: text().notNull(),
    name: text().notNull(),
    description: text().notNull(),
    code: text().notNull(),
    time_created: Timestamps.time_created,
    time_updated: Timestamps.time_updated,
  },
  (table) => [
    index("project_tool_project_idx").on(table.project_id),
    uniqueIndex("project_tool_project_name_idx").on(table.project_id, table.name),
  ],
)
