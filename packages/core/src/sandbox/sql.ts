import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql.js"

export type State = "creating" | "running" | "snapshotting" | "killed" | "destroyed"

export const SandboxTable = sqliteTable(
  "sandbox",
  {
    id: text().primaryKey(),
    session_id: text().notNull(),
    host: text().notNull(),
    provider: text().$type<"opensandbox" | "vercel" | "aliyun" | "e2b">().notNull().default("opensandbox"),
    provider_scope: text(),
    remote_name: text(),
    endpoint_token: text(),
    state: text().$type<State>().notNull(),
    keep_alive: integer({ mode: "boolean" }).notNull().default(false),
    command_session_id: text(),
    ...Timestamps,
  },
  (table) => [
    uniqueIndex("sandbox_session_id_idx").on(table.session_id),
    index("sandbox_state_time_updated_idx").on(table.state, table.time_updated),
  ],
)

export const SandboxCommandTable = sqliteTable("sandbox_command", {
  id: text().primaryKey(),
  session_id: text().notNull(),
  sandbox_id: text().notNull(),
  command_id: text().notNull(),
  operation_id: text().notNull(),
  ...Timestamps,
}, (table) => [index("sandbox_command_session_idx").on(table.session_id, table.sandbox_id)])

/** Independent Aliyun snapshots, not OpenSandbox manifests. */
export const AliyunSnapshotTable = sqliteTable("aliyun_snapshot", {
  id: text().primaryKey(),
  session_id: text().notNull(),
  provider_scope: text().notNull(),
  sandbox_id: text().notNull(),
  remote_name: text().notNull(),
  snapshot_id: text(),
  state: text().$type<"creating" | "ready">().notNull(),
  restored_count: integer().notNull().default(0),
  ...Timestamps,
}, (table) => [index("aliyun_snapshot_session_idx").on(table.session_id, table.time_created)])

/** E2B checkpoints are isolated from Aliyun and OpenSandbox catalogs. */
export const E2BSnapshotTable = sqliteTable("e2b_snapshot", {
  id: text().primaryKey(),
  session_id: text().notNull(),
  provider_scope: text().notNull(),
  sandbox_id: text().notNull(),
  remote_name: text().notNull(),
  snapshot_id: text(),
  state: text().$type<"creating" | "ready">().notNull(),
  restored_count: integer().notNull().default(0),
  ...Timestamps,
}, (table) => [index("e2b_snapshot_session_idx").on(table.session_id, table.time_created)])
