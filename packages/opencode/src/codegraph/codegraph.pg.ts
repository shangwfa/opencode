import { pgTable, text, integer, bigint, jsonb, bigserial, index, primaryKey } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import { Timestamps } from "../storage/schema.pg"

/**
 * SaaS codegraph knowledge-graph tables (see docs/saas-codegraph-design.md).
 *
 * Isolation: every row is keyed by `scope = "app:" + appId` — the application
 * dimension. Multiple sessions of one app share one graph. pvcMode is
 * intentionally NOT consulted (it serves volume routing only).
 *
 * Source code bodies are never stored: nodes carry locations only; reading
 * source stays with the sandbox read tool.
 */

export const CodegraphNodeTable = pgTable(
  "codegraph_node",
  {
    scope: text().notNull(),
    id: text().notNull(),
    kind: text().notNull(),
    name: text().notNull(),
    qualified_name: text().notNull(),
    file_path: text().notNull(),
    language: text().notNull(),
    start_line: integer().notNull(),
    end_line: integer().notNull(),
    start_col: integer().notNull(),
    end_col: integer().notNull(),
    docstring: text(),
    signature: text(),
    visibility: text(),
    is_exported: integer().notNull().default(0),
    is_async: integer().notNull().default(0),
    is_static: integer().notNull().default(0),
    is_abstract: integer().notNull().default(0),
    decorators: jsonb().$type<string[]>(),
    type_parameters: jsonb().$type<string[]>(),
    return_type: text(),
    is_generated: integer().notNull().default(0),
    time_updated: bigint({ mode: "number" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.scope, t.id] }),
    index("codegraph_node_name_idx").on(t.scope, t.name),
    index("codegraph_node_file_idx").on(t.scope, t.file_path, t.start_line),
    index("codegraph_node_qname_idx").on(t.scope, t.qualified_name),
  ],
)

export const CodegraphEdgeTable = pgTable(
  "codegraph_edge",
  {
    // No FK to codegraph_node: bulk per-file rebuilds delete+reinsert thousands
    // of rows; cascade triggers would dominate that cost. Referential
    // integrity is the writer's (single advisory-locked transaction) job.
    id: bigserial({ mode: "number" }).primaryKey(),
    scope: text().notNull(),
    source: text().notNull(),
    target: text().notNull(),
    kind: text().notNull(),
    metadata: jsonb().$type<Record<string, unknown>>(),
    line: integer(),
    col: integer(),
    provenance: text(),
  },
  (t) => [
    index("codegraph_edge_src_idx").on(t.scope, t.source, t.kind),
    index("codegraph_edge_tgt_idx").on(t.scope, t.target, t.kind),
  ],
)

export const CodegraphFileTable = pgTable(
  "codegraph_file",
  {
    scope: text().notNull(),
    path: text().notNull(),
    content_hash: text().notNull(),
    language: text().notNull(),
    size: integer().notNull(),
    mtime_ms: bigint({ mode: "number" }).notNull().default(0),
    node_count: integer().notNull().default(0),
    is_generated: integer().notNull().default(0),
    indexed_at: bigint({ mode: "number" }).notNull(),
    ...Timestamps,
  },
  (t) => [primaryKey({ columns: [t.scope, t.path] })],
)

export const CodegraphRefTable = pgTable(
  "codegraph_ref",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    scope: text().notNull(),
    from_node_id: text().notNull(),
    reference_name: text().notNull(),
    reference_kind: text().notNull(),
    line: integer().notNull(),
    col: integer().notNull(),
    file_path: text().notNull().default(""),
    language: text().notNull().default("unknown"),
    status: text().notNull().default("pending"),
  },
  (t) => [
    index("codegraph_ref_from_idx").on(t.scope, t.from_node_id),
    index("codegraph_ref_name_idx").on(t.scope, t.reference_name),
    index("codegraph_ref_pending_idx")
      .on(t.scope, t.status)
      .where(sql`status = 'pending'`),
  ],
)

export const CodegraphIndexTable = pgTable("codegraph_index", {
  scope: text().primaryKey(),
  // pending → indexing → ready | failed; "indexing" rows whose heartbeat is
  // stale are treated as reclaimable (writer died mid-run).
  state: text().notNull().default("pending"),
  files_total: integer().notNull().default(0),
  files_done: integer().notNull().default(0),
  node_count: integer().notNull().default(0),
  edge_count: integer().notNull().default(0),
  engine_version: text(),
  error: text(),
  // Files observed changed by the watch loop but not yet synced into the
  // graph — surfaced by tools as a staleness banner (codegraph issue #403).
  stale_files: jsonb().$type<string[]>().notNull().default([]),
  heartbeat_at: bigint({ mode: "number" }).notNull().default(0),
  ...Timestamps,
})

export * as CodegraphPG from "./codegraph.pg"
