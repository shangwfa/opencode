export * as SandboxSnapshot from "./snapshot.js"

import { SandboxApiException, SandboxManager } from "@alibaba-group/opensandbox"
import type { ConnectionConfig } from "@alibaba-group/opensandbox"
import { Duration, Effect } from "effect"
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm"
import { SessionSnapshotTable, type State } from "./snapshot.sql.js"

export type Row = typeof SessionSnapshotTable.$inferSelect
export const SCHEMA_VERSION = 1

export type Deps = {
  /** Drizzle database handle from Database.Service (Effect-flavored). */
  readonly db: unknown
  readonly connectionConfig: ConnectionConfig
  readonly ttlMs: number
  readonly waitMs: number
  /** Physical remote deletion gate; when off, TTL/superseded/session-delete keep snapshots and the remote TTL reaps them. */
  readonly deleteEnabled: boolean
}

const POLL_INTERVAL = Duration.seconds(5)

/** V2 port of the V1 session-snapshot state machine (docs/sandbox-snapshot-design.md). */
export function create<A, B>(deps: Deps) {
  // The provider's Effect-flavored drizzle handle; typed loosely here and
  // narrowed at the call sites that provider.ts already exercises.
  const db = deps.db as never as DrizzleDb
  const manager = SandboxManager.create({ connectionConfig: deps.connectionConfig })

  type Selected = {
    from: (table: unknown) => {
      where: (condition: unknown) => {
        orderBy: (order: unknown) => { limit: (n: number) => { all: () => Effect.Effect<Row[]> } }
        limit: (n: number) => { all: () => Effect.Effect<Row[]> }
        all: () => Effect.Effect<Row[]>
      }
      limit: (n: number) => { all: () => Effect.Effect<Row[]> }
    }
  }
  type DrizzleDb = {
    select: ((fields: Record<string, unknown>) => Selected) & (() => Selected)
    update: (table: unknown) => {
      set: (values: Record<string, unknown>) => {
        where: (condition: unknown) => {
          returning: (fields: Record<string, unknown>) => { all: () => Effect.Effect<Row[]> }
          run: () => Effect.Effect<unknown>
        }
      }
    }
    insert: (table: unknown) => {
      values: (values: Record<string, unknown>) => { run: () => Effect.Effect<unknown> }
    }
  }

  const failureDetail = (status: { reason?: string; message?: string }) =>
    [status.reason, status.message].filter((part): part is string => !!part).join(": ")

  const setState = (id: string, state: State, reason: string | null, expected?: State[]) =>
    db
      .update(SessionSnapshotTable)
      .set({ state, reason, time_updated: Date.now() })
      .where(and(eq(SessionSnapshotTable.id, id), ...(expected ? [inArray(SessionSnapshotTable.state, expected)] : [])))
      .returning({ id: SessionSnapshotTable.id })
      .all()

  function findRestorable(sessionID: string) {
    return db
      .select()
      .from(SessionSnapshotTable)
      .where(
        and(
          eq(SessionSnapshotTable.session_id, sessionID),
          eq(SessionSnapshotTable.scope, "session"),
          inArray(SessionSnapshotTable.state, ["ready", "stale"]),
        ),
      )
      .orderBy(desc(SessionSnapshotTable.time_created))
      .limit(1)
      .all()
  }

  /** Latest restorable row (ready/stale) for a session, or null. */
  const restorable = (sessionID: string) => findRestorable(sessionID)

  /** Session-scoped snapshot aggregates for observability (GET /snapshot/stats parity). */
  const stats = (sessionID: string) =>
    Effect.gen(function* () {
      const rows = yield* db
        .select()
        .from(SessionSnapshotTable)
        .where(eq(SessionSnapshotTable.session_id, sessionID))
        .all()
        .pipe(Effect.catch(() => Effect.succeed([] as Row[])))
      const snapshots: Record<string, number> = {}
      let restoredTotal = 0
      for (const row of rows) {
        snapshots[row.state] = (snapshots[row.state] ?? 0) + 1
        restoredTotal += row.restored_count
      }
      return { snapshots, total: rows.length, restoredTotal }
    })

  /** Before createSandbox: return the restorable snapshot (or null → cold start). */
  const resolveForCreate = (sessionID: string) =>
    findRestorable(sessionID).pipe(
      Effect.map((rows) => {
        const row = rows[0]
        return row ? { id: row.id, image: row.image, arch: row.arch, schemaVersion: row.schema_version } : null
      }),
      Effect.catchCause(() => Effect.succeed(null)),
    )

  /** Restore failed: mark failed so the next create cold-starts. */
  const markRestoreFailed = (sessionID: string, snapshotID: string, reason: string) =>
    db
      .update(SessionSnapshotTable)
        .set({ state: "failed", reason, time_updated: Date.now() })
      .where(
        and(
          eq(SessionSnapshotTable.id, snapshotID),
          eq(SessionSnapshotTable.session_id, sessionID),
          inArray(SessionSnapshotTable.state, ["ready", "stale"]),
        ),
      )
      .run()
      .pipe(Effect.ignore)

  /** Consumed by a restore: becomes stale (still restorable as fallback) until superseded. */
  const markConsumed = (snapshotID: string) =>
    db
      .update(SessionSnapshotTable)
      .set({
        state: "stale",
        reason: "restored",
        restored_count: sql`${SessionSnapshotTable.restored_count} + 1`,
        last_restored_at: Date.now(),
        time_updated: Date.now(),
      })
      .where(and(eq(SessionSnapshotTable.id, snapshotID), inArray(SessionSnapshotTable.state, ["ready", "stale"])))
      .run()
      .pipe(Effect.ignore)

  const getById = (id: string) =>
    db
      .select()
      .from(SessionSnapshotTable)
      .where(eq(SessionSnapshotTable.id, id))
      .limit(1)
      .all()

  const deleteSnapshot = (row: Row, reason: string) =>
    Effect.gen(function* () {
      if (!deps.deleteEnabled) return
      if (row.state !== "deleting") {
        const claimed = yield* setState(row.id, "deleting", reason, ["creating", "ready", "stale", "failed"])
        if (claimed.length === 0) return
      }
      const removed = yield* Effect.tryPromise({
        try: () => manager.deleteSnapshot(row.id),
        catch: (cause) => (cause instanceof SandboxApiException && cause.statusCode === 404 ? null : cause),
      }).pipe(Effect.result)
      if (removed._tag === "Success") {
        yield* setState(row.id, "deleted", reason, ["deleting"]).pipe(Effect.ignore)
      }
    })

  const deleteSiblingSnapshots = (sessionID: string, keepID: string) =>
    Effect.gen(function* () {
      const rows = yield* db
        .select()
        .from(SessionSnapshotTable)
        .where(
          and(
            eq(SessionSnapshotTable.session_id, sessionID),
            eq(SessionSnapshotTable.scope, "session"),
            inArray(SessionSnapshotTable.state, ["ready", "stale", "failed"]),
          ),
        )
        .all()
      for (const row of rows) {
        if (row.id === keepID) continue
        yield* deleteSnapshot(row, "superseded").pipe(Effect.ignore)
      }
    })

  /**
   * Start a snapshot: createSnapshot on the remote plus a `creating` row.
   * Returns the existing creating snapshot when one is already in flight
   * (concurrent fibers wait on the same snapshot instead of double-committing;
   * a wedged creating row is reconciled by gc).
   */
  const startSnapshot = (
    sandboxID: string,
    sessionID: string,
    opts?: { image?: string | null; arch?: string | null; schemaVersion?: number | null; runtimeVersion?: string | null },
  ) =>
    Effect.gen(function* () {
      const existing = yield* db
        .select()
        .from(SessionSnapshotTable)
        .where(
          and(
            eq(SessionSnapshotTable.session_id, sessionID),
            eq(SessionSnapshotTable.scope, "session"),
            eq(SessionSnapshotTable.state, "creating"),
          ),
        )
        .orderBy(desc(SessionSnapshotTable.time_created))
        .limit(1)
        .all()
      if (existing[0]) return existing[0].id

      const info = yield* Effect.tryPromise({
        try: () => manager.createSnapshot(sandboxID, { name: sessionID }),
        catch: (cause) => new Error(`createSnapshot failed: ${String(cause)}`),
      })
      yield* db
        .insert(SessionSnapshotTable)
        .values({
          id: info.id,
          session_id: sessionID,
          scope: "session",
          state: "creating",
          source_sandbox_id: sandboxID,
          image: opts?.image ?? null,
          arch: opts?.arch ?? null,
          schema_version: opts?.schemaVersion ?? SCHEMA_VERSION,
          runtime_version: opts?.runtimeVersion ?? null,
          time_created: Date.now(),
          time_updated: Date.now(),
        })
        .run()
        .pipe(Effect.orDie)
      return info.id
    })

  /**
   * Wait for a snapshot to settle. Ready → mark ready + clean siblings.
   * Failed/timeout → mark failed (timeout keeps `creating` for gc to reconcile;
   * the caller must keep the source sandbox alive while a snapshot is still
   * Creating — killing it mid-commit fails the snapshot).
   */
  const awaitSnapshot = (sessionID: string, snapshotID: string, waitMs = deps.waitMs) =>
    Effect.gen(function* () {
      const deadline = Date.now() + waitMs
      let last: { reason?: string; message?: string } | null = null
      while (Date.now() < deadline) {
        const statusExit = yield* Effect.tryPromise({
          try: async () => (await manager.getSnapshot(snapshotID)).status,
          catch: (cause) => new Error(`getSnapshot failed: ${String(cause)}`),
        }).pipe(Effect.result)
        if (statusExit._tag === "Success") {
          const current = statusExit.success
          last = current
          if (current.state === "Ready") {
            const persisted = yield* setState(snapshotID, "ready", null, ["creating"]).pipe(
              Effect.map((rows) => rows.length > 0),
              Effect.catch(() => Effect.succeed(false)),
            )
            if (!persisted) {
              const rows = yield* getById(snapshotID).pipe(Effect.catch(() => Effect.succeed([] as Row[])))
              if (rows[0]?.state !== "ready") return "failed" as const
            }
            yield* deleteSiblingSnapshots(sessionID, snapshotID).pipe(Effect.ignore)
            return "ready" as const
          }
          if (current.state === "Failed") {
            const detail = failureDetail(current)
            yield* setState(
              snapshotID,
              "failed",
              `server Failed${detail ? `: ${detail}` : ""}`,
              ["creating"],
            ).pipe(Effect.ignore)
            return "failed" as const
          }
        }
        yield* Effect.sleep(POLL_INTERVAL)
      }
      const detail = last ? failureDetail(last) : ""
      yield* setState(
        snapshotID,
        "creating",
        detail ? `wait timeout: ${detail}` : "wait timeout",
        ["creating"],
      ).pipe(Effect.ignore)
      return "timeout" as const
    })

  /** Latest snapshot of a session in any live state (GET /api/session/:id/snapshot). */
  const getLatest = (sessionID: string) =>
    db
      .select()
      .from(SessionSnapshotTable)
      .where(
        and(
          eq(SessionSnapshotTable.session_id, sessionID),
          eq(SessionSnapshotTable.scope, "session"),
          inArray(SessionSnapshotTable.state, ["creating", "ready", "stale", "failed"]),
        ),
      )
      .orderBy(desc(SessionSnapshotTable.time_created))
      .limit(1)
      .all()

  /**
   * GC + reconciliation, ridden on the idle-reap scan cycle:
   * TTL-expired terminal snapshots → remote delete; wedged `creating` rows →
   * reconcile against the remote (Ready fix-up, Failed/404 → failed).
   */
  const gc = () =>
    Effect.gen(function* () {
      const now = Date.now()
      const expired = yield* db
        .select()
        .from(SessionSnapshotTable)
        .where(
          or(
            eq(SessionSnapshotTable.state, "deleting"),
            and(
              inArray(SessionSnapshotTable.state, ["ready", "stale", "failed"]),
              lt(SessionSnapshotTable.time_created, now - deps.ttlMs),
            ),
          ),
        )
        .limit(50)
        .all()
      for (const row of expired) {
        yield* deleteSnapshot(row, row.state === "deleting" ? row.reason ?? "delete retry" : "ttl expired").pipe(
          Effect.ignore,
        )
      }

      const stuck = yield* db
        .select()
        .from(SessionSnapshotTable)
        .where(
          and(eq(SessionSnapshotTable.state, "creating"), lt(SessionSnapshotTable.time_created, now - deps.waitMs - 60_000)),
        )
        .limit(20)
        .all()
      for (const row of stuck) {
        const statusExit = yield* Effect.tryPromise({
          try: async () => (await manager.getSnapshot(row.id)).status,
          catch: (cause) => (cause instanceof SandboxApiException && cause.statusCode === 404 ? null : cause),
        }).pipe(Effect.result)
        if (statusExit._tag === "Failure") continue
        const current = statusExit.success
        if (current === null) {
          yield* setState(row.id, "failed", "reconcile: not found on server", ["creating"]).pipe(Effect.ignore)
          continue
        }
        if (current.state === "Ready") {
          const persisted = yield* setState(row.id, "ready", "reconciled", ["creating"])
          if (persisted.length === 0) continue
          if (row.session_id) yield* deleteSiblingSnapshots(row.session_id, row.id).pipe(Effect.ignore)
        } else if (current.state === "Failed") {
          const detail = failureDetail(current)
          yield* setState(row.id, "failed", `reconcile: Failed${detail ? `: ${detail}` : ""}`, ["creating"]).pipe(
            Effect.ignore,
          )
        }
      }
    })

  /** Session deletion hook: remove every snapshot of the session (gated by deleteEnabled). */
  const deleteAllForSession = (sessionID: string) =>
    Effect.gen(function* () {
      const rows = yield* db
        .select()
        .from(SessionSnapshotTable)
        .where(eq(SessionSnapshotTable.session_id, sessionID))
        .all()
      for (const row of rows) {
        if (row.state === "deleted") continue
        yield* deleteSnapshot(row, "session deleted").pipe(Effect.ignore)
      }
    })

  return {
    resolveForCreate,
    restorable,
    stats,
    markRestoreFailed,
    markConsumed,
    startSnapshot,
    awaitSnapshot,
    getLatest,
    gc,
    deleteAllForSession,
  }
}

export type SandboxSnapshots = ReturnType<typeof create>
