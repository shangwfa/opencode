import { and, eq, inArray, notInArray, or, sql } from "drizzle-orm"
import { CodegraphEdgeTable, CodegraphFileTable, CodegraphIndexTable, CodegraphNodeTable, CodegraphRefTable } from "./codegraph.pg"
import { Database, dialect } from "../storage/db"
import { kindBonus, nameMatchBonus, scorePathRelevance, isLowConfidenceQuery } from "./search"

/**
 * PG-only read/write layer for the codegraph tables (PG is the only SaaS
 * target per repo convention; every call is a no-op error in sqlite mode).
 *
 * Plain async functions, not an Effect service: the indexer (P3) and the
 * tools (P4) wrap these; keeping this layer framework-free keeps it testable
 * against a bare PG URL.
 */

export type Scope = string

export type GraphNode = typeof CodegraphNodeTable.$inferSelect
export type GraphEdge = typeof CodegraphEdgeTable.$inferSelect
export type GraphFile = typeof CodegraphFileTable.$inferSelect
export type GraphRef = typeof CodegraphRefTable.$inferSelect

/** scope = "app:" + appId — the application dimension (see codegraph.pg.ts). */
export const scopeFor = (appId: string) => `app:${appId}`

/** Extraction record shapes emitted by the sandbox extractor (ndjson lines). */
export type ExtractNode = typeof CodegraphNodeTable.$inferInsert
export type ExtractEdge = typeof CodegraphEdgeTable.$inferInsert
export type ExtractFile = typeof CodegraphFileTable.$inferInsert
export type ExtractRef = typeof CodegraphRefTable.$inferInsert

const BATCH = 1000

const use = async <T>(fn: (d: any) => T | Promise<T>): Promise<T> => {
  if (dialect !== "pg") throw new Error("codegraph requires PG (OPENCODE_DATABASE_URL)")
  return Database.use(fn as any) as Promise<T>
}

/** Transaction-scoped advisory lock — one writer per scope. */
const lockScope = (tx: any, scope: Scope) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"codegraph:" + scope}))`)

const insertBatches = async (tx: any, table: any, rows: any[]) => {
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH)
    if (slice.length > 0) await tx.insert(table).values(slice).run()
  }
}

/**
 * The codegraph kernel occasionally emits two rows with the SAME node id for
 * one symbol (e.g. a nested Dart function surfaced under both
 * `hostFn::localFn` and the flat `localFn` qualified name) — same id hash,
 * different qualified_name. PG's (scope,id) PK rejects that, so dedupe by id
 * (keep first) before every bulk insert.
 */
const dedupeNodes = (rows: any[]): any[] => {
  const seen = new Set<string>()
  const out: any[] = []
  for (const r of rows) {
    if (r.id && seen.has(r.id)) continue
    if (r.id) seen.add(r.id)
    out.push(r)
  }
  return out
}

// ---------------------------------------------------------------------------
// Index state machine: pending → indexing → ready | failed.
// A row stuck in "indexing" with a stale heartbeat means its writer died
// (server restart mid-run) — reclaimable by the next indexer.
// ---------------------------------------------------------------------------

export const STALE_HEARTBEAT_MS = 120_000

export type IndexState = typeof CodegraphIndexTable.$inferSelect | null

// postgres.js may hand jsonb columns back as raw strings depending on the
// installed OID overrides — normalize so callers always see parsed values.
const parseIndexRow = (row: any): IndexState => {
  if (!row) return null
  if (typeof row.stale_files === "string") {
    try {
      row.stale_files = JSON.parse(row.stale_files)
    } catch {
      row.stale_files = []
    }
  }
  return row as IndexState
}

export const getIndex = (scope: Scope) =>
  use(async (d) => parseIndexRow(await d.select().from(CodegraphIndexTable).where(sql`scope = ${scope}`).get()))

/** True when the row claims "indexing" but its writer is gone. */
export const isZombie = (state: IndexState, now = Date.now()) =>
  !!state && state.state === "indexing" && now - state.heartbeat_at > STALE_HEARTBEAT_MS

/**
 * Try to become the writer for `scope`. Returns false when someone else holds
 * a live claim (state=indexing with fresh heartbeat) — the caller should then
 * read-share the existing graph instead of writing.
 */
export const claimIndexing = async (scope: Scope, engineVersion: string) =>
  use(async (d: any) => {
    const rows = await d
      .insert(CodegraphIndexTable)
      .values({ scope, state: "indexing", files_total: 0, files_done: 0, engine_version: engineVersion, heartbeat_at: Date.now() })
      .onConflictDoUpdate({
        target: CodegraphIndexTable.scope,
        set: {
          state: sql`'indexing'`,
          files_total: 0,
          files_done: 0,
          error: null,
          engine_version: engineVersion,
          heartbeat_at: Date.now(),
        },
        // Only take over when idle, finished, failed, or zombied — never
        // preempt a live writer.
        setWhere: sql`"codegraph_index"."state" != 'indexing' or "codegraph_index"."heartbeat_at" < ${Date.now() - STALE_HEARTBEAT_MS}`,
      })
      .returning({ scope: CodegraphIndexTable.scope })
      .get()
    return !!rows
  })

export const heartbeat = (scope: Scope, filesDone?: number, filesTotal?: number) =>
  use((d: any) =>
    d
      .update(CodegraphIndexTable)
      .set({
        heartbeat_at: Date.now(),
        ...(filesDone !== undefined ? { files_done: filesDone } : {}),
        ...(filesTotal !== undefined ? { files_total: filesTotal } : {}),
      })
      .where(sql`scope = ${scope}`)
      .run(),
  )

export const finishIndex = (scope: Scope, nodes: number, edges: number) =>
  use((d: any) =>
    d
      .insert(CodegraphIndexTable)
      .values({ scope, state: "ready", node_count: nodes, edge_count: edges, files_done: 0, heartbeat_at: Date.now(), stale_files: [] })
      .onConflictDoUpdate({
        target: CodegraphIndexTable.scope,
        set: { state: "ready", node_count: nodes, edge_count: edges, files_done: sql`codegraph_index.files_total`, heartbeat_at: Date.now(), stale_files: [] },
      })
      .run(),
  )

export const failIndex = (scope: Scope, error: string) =>
  use((d: any) => d.update(CodegraphIndexTable).set({ state: "failed", error, heartbeat_at: Date.now() }).where(sql`scope = ${scope}`).run())

export const setStaleFiles = (scope: Scope, files: string[]) =>
  use((d: any) => d.update(CodegraphIndexTable).set({ stale_files: files, heartbeat_at: Date.now() }).where(sql`scope = ${scope}`).run())

/** Drop all graph data for a scope (app deletion). */
export const purgeScope = (scope: Scope) =>
  use(async (d: any) => {
    await d.transaction(async (tx: any) => {
      await lockScope(tx, scope)
      await tx.delete(CodegraphNodeTable).where(sql`scope = ${scope}`).run()
      await tx.delete(CodegraphEdgeTable).where(sql`scope = ${scope}`).run()
      await tx.delete(CodegraphFileTable).where(sql`scope = ${scope}`).run()
      await tx.delete(CodegraphRefTable).where(sql`scope = ${scope}`).run()
      await tx.delete(CodegraphIndexTable).where(sql`scope = ${scope}`).run()
    })
  })

// ---------------------------------------------------------------------------
// Bulk persist (full snapshot from the sandbox extractor).
// ---------------------------------------------------------------------------

export type ExtractSnapshot = {
  nodes: ExtractNode[]
  edges: ExtractEdge[]
  files: ExtractFile[]
  refs: ExtractRef[]
}

/**
 * Replace the whole graph for `scope` in one locked transaction: either the
 * new snapshot lands completely or nothing changes (a half-written graph must
 * never be visible to tools).
 */
export const replaceGraph = async (scope: Scope, snap: ExtractSnapshot) => {
  await use(async (d: any) => {
    await d.transaction(async (tx: any) => {
      await lockScope(tx, scope)
      await tx.delete(CodegraphNodeTable).where(sql`scope = ${scope}`).run()
      await tx.delete(CodegraphEdgeTable).where(sql`scope = ${scope}`).run()
      await tx.delete(CodegraphFileTable).where(sql`scope = ${scope}`).run()
      await tx.delete(CodegraphRefTable).where(sql`scope = ${scope}`).run()
      await insertBatches(tx, CodegraphNodeTable, dedupeNodes(snap.nodes))
      await insertBatches(tx, CodegraphEdgeTable, snap.edges)
      await insertBatches(tx, CodegraphFileTable, snap.files)
      await insertBatches(tx, CodegraphRefTable, snap.refs)
    })
  })
  await finishIndex(scope, snap.nodes.length, snap.edges.length)
}

/**
 * Incremental variant: delete+reinsert only the given files' nodes/edges/refs
 * (nodes carry file_path so scoping deletes by path is exact).
 */
export const replaceFiles = async (scope: Scope, paths: string[], snap: ExtractSnapshot) => {
  await use(async (d: any) => {
    await d.transaction(async (tx: any) => {
      await lockScope(tx, scope)
      for (const p of paths) {
        // Edges first: they reference nodes being removed (no FK, manual order).
        await tx.delete(CodegraphEdgeTable).where(sql`scope = ${scope} and (source in (select id from codegraph_node where scope = ${scope} and file_path = ${p}) or target in (select id from codegraph_node where scope = ${scope} and file_path = ${p}))`).run()
        await tx.delete(CodegraphRefTable).where(sql`scope = ${scope} and file_path = ${p}`).run()
        await tx.delete(CodegraphNodeTable).where(sql`scope = ${scope} and file_path = ${p}`).run()
        await tx.delete(CodegraphFileTable).where(sql`scope = ${scope} and path = ${p}`).run()
      }
      await insertBatches(tx, CodegraphNodeTable, dedupeNodes(snap.nodes))
      await insertBatches(tx, CodegraphEdgeTable, snap.edges)
      await insertBatches(tx, CodegraphFileTable, snap.files)
      await insertBatches(tx, CodegraphRefTable, snap.refs)
    })
  })
}

// ---------------------------------------------------------------------------
// File ledger — incremental change detection (stat pre-filter + hash confirm,
// never `git status`: committed changes after pull/checkout are invisible to
// it — the git blind spot codegraph itself hit).
// ---------------------------------------------------------------------------

export const listFileStats = (scope: Scope) =>
  use(
    (d) =>
      d
        .select({ path: CodegraphFileTable.path, content_hash: CodegraphFileTable.content_hash, size: CodegraphFileTable.size, mtime_ms: CodegraphFileTable.mtime_ms })
        .from(CodegraphFileTable)
        .where(sql`scope = ${scope}`)
        .all() as { path: string; content_hash: string; size: number; mtime_ms: number }[],
  )

/** Paths known to the graph but absent from the sandbox stat list → deleted files. */
export const dropMissingFiles = (scope: Scope, livePaths: string[]) =>
  use(async (d: any) => {
    await d.transaction(async (tx: any) => {
      await lockScope(tx, scope)
      const gone = sql`(select id from ${CodegraphNodeTable} where scope = ${scope} and ${notInArray(CodegraphNodeTable.file_path, livePaths)})`
      await tx.delete(CodegraphEdgeTable).where(and(eq(CodegraphEdgeTable.scope, scope), or(inArray(CodegraphEdgeTable.source, gone), inArray(CodegraphEdgeTable.target, gone)))).run()
      await tx.delete(CodegraphRefTable).where(and(eq(CodegraphRefTable.scope, scope), notInArray(CodegraphRefTable.file_path, livePaths))).run()
      await tx.delete(CodegraphNodeTable).where(and(eq(CodegraphNodeTable.scope, scope), notInArray(CodegraphNodeTable.file_path, livePaths))).run()
      await tx.delete(CodegraphFileTable).where(and(eq(CodegraphFileTable.scope, scope), notInArray(CodegraphFileTable.path, livePaths))).run()
    })
  })

// ---------------------------------------------------------------------------
// Search — four layers aligned with codegraph searchNodes:
//   ① tsvector FTS (prefix OR over identifier segments, weighted rank)
//   ② ILIKE substring fallback (trgm GIN)
//   ③ trgm similarity fallback (≈ edit-distance layer)
//   ④ exact-name supplement (never buried by ranking)
// ---------------------------------------------------------------------------

/** Split a query into tsquery-safe prefix segments ("userServ" → "user:* | serv:*"). */
export const toPrefixTsQuery = (query: string): string => {
  const segs = query
    .split(/[^a-zA-Z0-9]+/)
    .filter((s) => s.length >= 2)
    .flatMap((s) => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(" "))
    .map((s) => s.toLowerCase().replace(/[^a-z0-9]/g, ""))
    .filter((s) => s.length >= 2)
  const uniq = [...new Set(segs)]
  return uniq.length === 0 ? "" : uniq.map((s) => `${s}:*`).join(" | ")
}

export type SearchOptions = { kind?: string; limit?: number }

export const searchNodes = async (scope: Scope, query: string, opts: SearchOptions = {}) => {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 100)
  // Fetch a wider candidate pool than the final limit so the TS re-rank
  // (name/kind/path bonuses) has room to promote good matches above noise.
  const pool = limit * 3
  const kindFilter = opts.kind ? sql` and kind = ${opts.kind}` : sql``
  return use(async (d: any) => {
    const rows: GraphNode[] = []
    const seen = new Set<string>()

    const push = (list: GraphNode[]) => {
      for (const r of list) {
        if (seen.has(r.id)) continue
        seen.add(r.id)
        rows.push(r)
      }
    }

    // ① FTS
    const tsq = toPrefixTsQuery(query)
    if (tsq) {
      push(
        await d
          .select()
          .from(CodegraphNodeTable)
          .where(sql`scope = ${scope}${kindFilter} and fts @@ to_tsquery('simple', ${tsq})`)
          .orderBy(sql`ts_rank('{0.05,0.1,0.25,1.0}', fts, to_tsquery('simple', ${tsq})) desc`)
          .limit(pool)
          .all(),
      )
    }
    // ④ exact name supplement — cheapest precise layer, run early so exact
    // matches are never pushed out by approximate layers below.
    push(await d.select().from(CodegraphNodeTable).where(sql`scope = ${scope}${kindFilter} and name = ${query}`).limit(pool).all())

    // ② substring (ILIKE, trgm GIN)
    if (rows.length < pool)
      push(
        await d
          .select()
          .from(CodegraphNodeTable)
          .where(sql`scope = ${scope}${kindFilter} and name ilike ${"%" + query.replace(/[%_]/g, "") + "%"}`)
          .limit(pool - rows.length)
          .all(),
      )

    // ③ trigram similarity
    if (rows.length < pool)
      push(
        await d
          .select()
          .from(CodegraphNodeTable)
          .where(sql`scope = ${scope}${kindFilter} and similarity(name, ${query}) > 0.3`)
          .orderBy(sql`similarity(name, ${query}) desc`)
          .limit(pool - rows.length)
          .all(),
      )

    // Multi-signal re-rank (codegraph searchNodes parity): exact-name / token
    // match dominates, then kind preference, then path relevance (which also
    // dampens test files). SQL ordering above only seeds the candidate pool.
    const scored = rows
      .map((n) => ({
        node: n,
        score: nameMatchBonus(n.name, query) + kindBonus(n.kind) + scorePathRelevance(n.file_path, query),
      }))
      .sort((a, b) => b.score - a.score)

    return scored.slice(0, limit).map((s) => s.node)
  })
}

export const findNodesByName = (scope: Scope, name: string) =>
  use((d) => d.select().from(CodegraphNodeTable).where(sql`scope = ${scope} and name = ${name}`).all() as GraphNode[])

export const getNodesByIds = (scope: Scope, ids: string[]) =>
  ids.length === 0
    ? Promise.resolve([] as GraphNode[])
    : use((d) => d.select().from(CodegraphNodeTable).where(and(eq(CodegraphNodeTable.scope, scope), inArray(CodegraphNodeTable.id, ids))).all() as GraphNode[])

export const getNodeById = (scope: Scope, id: string) =>
  use((d) => d.select().from(CodegraphNodeTable).where(and(eq(CodegraphNodeTable.scope, scope), eq(CodegraphNodeTable.id, id))).get() as GraphNode | undefined)

export const getNodesByQualifiedName = (scope: Scope, qn: string) =>
  use((d) => d.select().from(CodegraphNodeTable).where(sql`scope = ${scope} and qualified_name = ${qn}`).all() as GraphNode[])

// ---------------------------------------------------------------------------
// Reference-resolution support: keyset-paginated pending refs + the two
// resolver writes (resolver edges and ref status), each in one locked
// transaction so a concurrent resolver can never observe a torn state.
// ---------------------------------------------------------------------------

/** Pending refs after `afterId`, ascending id — keyset pagination avoids the
 * O(n²) offset scan on 80k+ ref scopes. */
export const listPendingRefs = (scope: Scope, opts: { limit: number; afterId: number; filePaths?: string[] }) =>
  use(
    (d) =>
      d
        .select()
        .from(CodegraphRefTable)
        .where(
          and(
            eq(CodegraphRefTable.scope, scope),
            eq(CodegraphRefTable.status, "pending"),
            opts.filePaths && opts.filePaths.length > 0 ? inArray(CodegraphRefTable.file_path, opts.filePaths) : undefined,
            sql`${CodegraphRefTable.id} > ${opts.afterId}`,
          ),
        )
        .orderBy(CodegraphRefTable.id)
        .limit(opts.limit)
        .all() as GraphRef[],
  )

/**
 * Idempotent resolver-edge commit: inside one advisory-locked transaction,
 * drop prior `provenance='resolver'` edges (scope-wide, or restricted to the
 * given files' nodes for incremental runs) then insert the fresh batch.
 */
export const replaceResolverEdges = (scope: Scope, edges: ExtractEdge[], filePaths?: string[]) =>
  use(async (d: any) => {
    await d.transaction(async (tx: any) => {
      await lockScope(tx, scope)
      const inFiles = sql`(select id from ${CodegraphNodeTable} where scope = ${scope} and ${inArray(CodegraphNodeTable.file_path, filePaths ?? [])})`
      const delWhere = and(
        eq(CodegraphEdgeTable.scope, scope),
        eq(CodegraphEdgeTable.provenance, "resolver"),
        filePaths && filePaths.length > 0
          ? or(inArray(CodegraphEdgeTable.source, inFiles), inArray(CodegraphEdgeTable.target, inFiles))
          : undefined,
      )
      await tx.delete(CodegraphEdgeTable).where(delWhere).run()
      await insertBatches(tx, CodegraphEdgeTable, edges)
    })
  })

export const markRefsStatus = (scope: Scope, ids: number[], status: string) =>
  use(async (d: any) => {
    for (let i = 0; i < ids.length; i += BATCH) {
      const slice = ids.slice(i, i + BATCH)
      if (slice.length > 0)
        await d.update(CodegraphRefTable).set({ status }).where(and(eq(CodegraphRefTable.scope, scope), inArray(CodegraphRefTable.id, slice))).run()
    }
  })

// ---------------------------------------------------------------------------
// Graph traversal primitives (callers implement BFS/callers/impact on top).
// ---------------------------------------------------------------------------

export const outgoingEdges = (scope: Scope, nodeId: string, kinds?: string[]) =>
  use((d) =>
    d
      .select()
      .from(CodegraphEdgeTable)
      .where(
        and(
          eq(CodegraphEdgeTable.scope, scope),
          eq(CodegraphEdgeTable.source, nodeId),
          kinds ? inArray(CodegraphEdgeTable.kind, kinds) : undefined,
        ),
      )
      .all() as GraphEdge[],
  )

export const incomingEdges = (scope: Scope, nodeId: string, kinds?: string[]) =>
  use((d) =>
    d
      .select()
      .from(CodegraphEdgeTable)
      .where(
        and(
          eq(CodegraphEdgeTable.scope, scope),
          eq(CodegraphEdgeTable.target, nodeId),
          kinds ? inArray(CodegraphEdgeTable.kind, kinds) : undefined,
        ),
      )
      .all() as GraphEdge[],
  )

// ---------------------------------------------------------------------------
// Graph traversal (BFS over edges — semantics aligned with codegraph's
// GraphTraverser: `instantiates` counts as a call, container `contains` edges
// do not count as dependency).
// ---------------------------------------------------------------------------

/** Edge kinds that constitute "a call" (codegraph getCallers/getCallees set). */
const CALL_KINDS = ["calls", "references", "imports", "instantiates"]

type TraversalResult = { node: GraphNode; edge: GraphEdge }[]

const batchNodes = async (scope: Scope, ids: string[]): Promise<Map<string, GraphNode>> => {
  const nodes = await getNodesByIds(scope, [...new Set(ids)])
  return new Map(nodes.map((n) => [n.id, n]))
}

const collectCallers = async (
  scope: Scope,
  startId: string,
  maxDepth: number,
  result: TraversalResult,
  visited: Set<string>,
  depth: number,
): Promise<void> => {
  if (depth >= maxDepth || visited.has(startId)) return
  visited.add(startId)
  const edges = await incomingEdges(scope, startId, CALL_KINDS)
  if (edges.length === 0) return
  const nodes = await batchNodes(scope, edges.map((e) => e.source))
  for (const e of edges) {
    const n = nodes.get(e.source)
    if (n && !visited.has(n.id)) {
      result.push({ node: n, edge: e })
      await collectCallers(scope, n.id, maxDepth, result, visited, depth + 1)
    }
  }
}

const collectCallees = async (
  scope: Scope,
  startId: string,
  maxDepth: number,
  result: TraversalResult,
  visited: Set<string>,
  depth: number,
): Promise<void> => {
  if (depth >= maxDepth || visited.has(startId)) return
  visited.add(startId)
  const edges = await outgoingEdges(scope, startId, CALL_KINDS)
  if (edges.length === 0) return
  const nodes = await batchNodes(scope, edges.map((e) => e.target))
  for (const e of edges) {
    const n = nodes.get(e.target)
    if (n && !visited.has(n.id)) {
      result.push({ node: n, edge: e })
      await collectCallees(scope, n.id, maxDepth, result, visited, depth + 1)
    }
  }
}

export const getCallers = (scope: Scope, nodeId: string, maxDepth = 1): Promise<TraversalResult> => {
  const out: TraversalResult = []
  return collectCallers(scope, nodeId, maxDepth, out, new Set(), 0).then(() => out)
}

export const getCallees = (scope: Scope, nodeId: string, maxDepth = 1): Promise<TraversalResult> => {
  const out: TraversalResult = []
  return collectCallees(scope, nodeId, maxDepth, out, new Set(), 0).then(() => out)
}

/** Impact radius: every incoming dependency edge (excluding `contains`). */
export const getImpact = async (scope: Scope, nodeId: string, maxDepth = 3): Promise<TraversalResult> => {  const out: TraversalResult = []
  const visited = new Set<string>()

  const walk = async (id: string, depth: number): Promise<void> => {
    if (depth >= maxDepth || visited.has(id)) return
    visited.add(id)
    const edges = (await incomingEdges(scope, id)).filter((e) => e.kind !== "contains")
    if (edges.length === 0) return
    const nodes = await batchNodes(scope, edges.map((e) => e.source))
    for (const e of edges) {
      const n = nodes.get(e.source)
      if (n && !visited.has(n.id)) {
        out.push({ node: n, edge: e })
        await walk(n.id, depth + 1)
      }
    }
  }
  await walk(nodeId, 0)
  return out
}

/** Direct `contains` children of a container node. */
export const getChildren = async (scope: Scope, nodeId: string): Promise<GraphNode[]> => {
  const edges = await outgoingEdges(scope, nodeId, ["contains"])
  if (edges.length === 0) return []
  const nodes = await getNodesByIds(scope, edges.map((e) => e.target))
  return edges
    .map((e) => nodes.find((n) => n.id === e.target))
    .filter((n): n is GraphNode => !!n)
}

export * as CodegraphStore from "./store"
