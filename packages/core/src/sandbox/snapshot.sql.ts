export * as SnapshotSql from "./snapshot.js"

import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { sql } from "drizzle-orm"
import { Timestamps } from "../database/schema.sql.js"

export type State = "creating" | "ready" | "failed" | "stale" | "deleting" | "deleted"

/**
 * One sandbox snapshot per row; `id` is the remote (OpenSandbox) snapshot id.
 * Compatibility/lineage metadata (`image`, `source_sandbox_id`, `arch`,
 * `schema_version`, `runtime_version`) is captured at creation so a restore
 * can refuse a drifted snapshot instead of failing inside the sandbox.
 * `restored_count`/`last_restored_at` track consumption; a consumed snapshot
 * becomes `stale` but stays restorable as a fallback until superseded.
 */
export const SessionSnapshotTable = sqliteTable(
  "session_snapshot",
  {
    id: text().primaryKey(),
    session_id: text(),
    scope: text().$type<"session" | "baseline">().notNull(),
    state: text().$type<State>().notNull(),
    reason: text(),
    image: text(),
    source_sandbox_id: text(),
    arch: text(),
    schema_version: integer(),
    runtime_version: text(),
    restored_count: integer().notNull().default(0),
    last_restored_at: integer(),
    ...Timestamps,
  },
  (table) => [
    index("session_snapshot_session_idx").on(table.session_id, table.state),
    // Cross-instance create dedup (V1 advisory-lock semantics): at most one
    // `creating` row per session+scope; a concurrent creator's insert hits
    // this index, rolls its remote snapshot back, and joins the existing one.
    uniqueIndex("session_snapshot_creating_uniq")
      .on(table.session_id, table.scope)
      .where(sql`${table.state} = 'creating'`),
  ],
)

export type OperationState = "pending" | "running" | "done" | "failed"
export type OperationKind = "snapshot_destroy" | "snapshot_refresh"

/** Durable work shared by all server instances. A refresh uses its own table so
 * an older destroy worker can never interpret a refresh job as permission to kill. */
const operationColumns = {
  id: text().primaryKey(),
  session_id: text().notNull(),
  sandbox_id: text(),
  kind: text().$type<OperationKind>().notNull(),
  state: text().$type<OperationState>().notNull(),
  attempts: integer().notNull().default(0),
  next_retry_at: integer(),
  lease_owner: text(),
  lease_until: integer(),
  fencing_token: integer().notNull().default(0),
  error: text(),
  ...Timestamps,
}

export const SnapshotOperationTable = sqliteTable(
  "snapshot_operation",
  operationColumns,
  (table) => [
    index("snapshot_operation_claim_idx").on(table.state, table.next_retry_at),
    index("snapshot_operation_session_idx").on(table.session_id, table.time_created),
    uniqueIndex("snapshot_operation_active_uniq")
      .on(table.session_id, table.sandbox_id, table.kind)
      .where(sql`${table.state} in ('pending', 'running')`),
  ],
)

export const SnapshotRefreshOperationTable = sqliteTable(
  "snapshot_refresh_operation",
  operationColumns,
  (table) => [
    index("snapshot_refresh_operation_claim_idx").on(table.state, table.next_retry_at),
    index("snapshot_refresh_operation_session_idx").on(table.session_id, table.time_created),
    uniqueIndex("snapshot_refresh_operation_active_uniq")
      .on(table.session_id, table.sandbox_id, table.kind)
      .where(sql`${table.state} in ('pending', 'running')`),
  ],
)
