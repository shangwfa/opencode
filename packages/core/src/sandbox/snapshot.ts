export * as SandboxSnapshot from "./snapshot.js"

import { SandboxApiException, SandboxManager } from "@alibaba-group/opensandbox"
import type { ConnectionConfig } from "@alibaba-group/opensandbox"
import { Clock, Duration, Effect } from "effect"
import { and, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm"
import { SessionSnapshotTable, type State } from "./snapshot.sql.js"
import { SessionTable } from "../session/sql.js"
import { randomUUID } from "node:crypto"

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
  readonly manager?: Pick<ReturnType<typeof SandboxManager.create>, "createSnapshot" | "deleteSnapshot" | "getSnapshot">
}

/** Observe normal checkpoints promptly; cap traffic for long jobs or API failures. */
export const snapshotPollIntervalMs = (elapsedMs: number, consecutiveErrors = 0): number =>
  consecutiveErrors > 0
    ? Math.min(5_000, 1_000 * 2 ** Math.min(consecutiveErrors, 3))
    : elapsedMs < 60_000 ? 1_000 : 5_000

/** Server-side arch label for a Node process.arch value (x64 → amd64), the
 * same normalization snapshot-reuse.ts applies to `uname -m` output so stored
 * snapshot arch values and live expectations compare equal. */
export const expectedSandboxArch = (processArch: string): string =>
  processArch === "x64" ? "amd64" : processArch

/** V1 parity drift observability (feat/opencode-1.18.31 "snapshot image/arch
 * drift; restoring anyway"): a restorable snapshot may have been taken from a
 * different image or arch than the environment the create will use. This is a
 * warning signal only — restore still proceeds and the remote platform stays
 * the final compatibility arbiter. Missing stored values never warn. */
export const snapshotDrift = (
  restorable: { image?: string | null; arch?: string | null },
  expected: { image: string; arch: string },
): { image?: { snapshot: string; expected: string }; arch?: { snapshot: string; expected: string } } | null => {
  const image =
    restorable.image && restorable.image !== expected.image
      ? { snapshot: restorable.image, expected: expected.image }
      : undefined
  const arch =
    restorable.arch && restorable.arch !== expected.arch
      ? { snapshot: restorable.arch, expected: expected.arch }
      : undefined
  return image || arch ? { ...(image ? { image } : {}), ...(arch ? { arch } : {}) } : null
}


/** V2 port of the V1 session-snapshot state machine (docs/sandbox-snapshot-design.md). */
export function create<A, B>(deps: Deps) {
  // The provider's Effect-flavored drizzle handle; typed loosely here and
  // narrowed at the call sites that provider.ts already exercises.
  const db = deps.db as never as DrizzleDb
  const manager = deps.manager ?? SandboxManager.create({ connectionConfig: deps.connectionConfig })

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
    transaction: <T>(work: (tx: DrizzleDb) => Effect.Effect<T, Error>) => Effect.Effect<T, Error>
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
      values: (values: Record<string, unknown>) => {
        run: () => Effect.Effect<unknown>
        onConflictDoNothing: () => {
          returning: (fields: Record<string, unknown>) => { all: () => Effect.Effect<Array<{ id: unknown }>> }
        }
      }
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

  /** Only absence permits cold start; a database failure must propagate. */
  const resolveForCreate = (sessionID: string) =>
    findRestorable(sessionID).pipe(
      Effect.map((rows) => {
        const row = rows[0]
        return row ? { id: row.id, image: row.image, arch: row.arch, schemaVersion: row.schema_version } : null
      }),
    )

  /** Keep the restorable checkpoint on restore failure; retry must not cold-start. */
  const markRestoreFailed = (sessionID: string, snapshotID: string, reason: string) =>
    db
      .update(SessionSnapshotTable)
      .set({ reason, time_updated: Date.now() })
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
            // Keep previous restorable versions until retention GC; creation
            // success alone does not prove the new checkpoint can be restored.
            eq(SessionSnapshotTable.state, "failed"),
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
   * Returns the existing creating snapshot when one is already in flight.
   * A session-row transaction lock arbitrates before remote creation; the
   * partial unique index remains a backstop for older/mixed-version writers.
   * A wedged creating row is reconciled by gc. Remote calls cannot participate
   * in the PG transaction: a lost response can still leave an orphan remotely.
   */
  const startSnapshot = (
    sandboxID: string,
    sessionID: string,
    opts?: {
      image?: string | null; arch?: string | null; schemaVersion?: number | null; runtimeVersion?: string | null
      prepare?: (token: string) => Effect.Effect<{ arch: string | null }, Error>
      /** Coalesce an overlapping request even if its winner already settled. */
      requestedAt?: number
    },
  ) =>
    db.transaction((tx) => Effect.gen(function* () {
      // Lock the session before the remote call. A no-op UPDATE uses the same
      // cross-instance transaction locking pattern as SessionToolGate.
      const locked = yield* tx
        .update(SessionTable)
        .set({ time_updated: sql`${SessionTable.time_updated}` })
        .where(eq(SessionTable.id, sessionID as typeof SessionTable.$inferSelect.id))
        .returning({ id: SessionTable.id })
        .all()
      if (locked.length === 0) return yield* Effect.fail(new Error(`Snapshot session not found: ${sessionID}`))
      const existing = yield* tx
        .select()
        .from(SessionSnapshotTable)
        .where(
          and(
            eq(SessionSnapshotTable.session_id, sessionID),
            eq(SessionSnapshotTable.scope, "session"),
            or(
              eq(SessionSnapshotTable.state, "creating"),
              ...(opts?.requestedAt !== undefined ? [and(
                inArray(SessionSnapshotTable.state, ["ready", "stale"]),
                gte(SessionSnapshotTable.time_created, opts.requestedAt),
                eq(SessionSnapshotTable.source_sandbox_id, sandboxID),
              )] : []),
            ),
          ),
        )
        .orderBy(desc(SessionSnapshotTable.time_created))
        .limit(1)
        .all()
      if (existing[0]) {
        if (existing[0].source_sandbox_id !== sandboxID)
          return yield* Effect.fail(new Error(`Snapshot source generation changed: ${sessionID}`))
        return existing[0].id
      }

      const token = randomUUID()
      const prepared = opts?.prepare ? yield* opts.prepare(token) : null
      const startedAt = Date.now()
      const info = yield* Effect.tryPromise({
        try: () => manager.createSnapshot(sandboxID, { name: sessionID }),
        catch: (cause) => new Error(`createSnapshot failed: ${String(cause)}`),
      })
      yield* Effect.logInfo("snapshot remote create completed", { sessionID, sandboxID, snapshotID: info.id, ms: Date.now() - startedAt })
      const registered = yield* tx.select().from(SessionSnapshotTable)
        .where(eq(SessionSnapshotTable.id, info.id)).limit(1).all()
      if (registered.length > 0)
        return yield* Effect.fail(new Error(`Remote snapshot ID already registered; retained: ${info.id}`))
      const rollbackRemote = Effect.tryPromise({
        try: () => manager.deleteSnapshot(info.id),
        catch: () => undefined,
      }).pipe(Effect.catchCause(() => Effect.void))
      const inserted = yield* tx
        .insert(SessionSnapshotTable)
        .values({
          id: info.id,
          session_id: sessionID,
          scope: "session",
          state: "creating",
          source_sandbox_id: sandboxID,
          image: opts?.image ?? null,
          arch: prepared?.arch ?? opts?.arch ?? null,
          schema_version: opts?.schemaVersion ?? SCHEMA_VERSION,
          runtime_version: opts?.runtimeVersion ?? null,
          manifest_token: prepared ? token : null,
          time_created: Date.now(),
          time_updated: Date.now(),
        })
        .onConflictDoNothing()
        .returning({ id: SessionSnapshotTable.id })
        .all()
        .pipe(Effect.result)
      if (inserted._tag === "Failure") {
        // The row could not be persisted: roll the remote snapshot back so it
        // does not leak, then surface the failure to the caller.
        if (deps.deleteEnabled) yield* rollbackRemote
        return yield* Effect.fail(new Error(`snapshot row insert failed: ${sessionID}`))
      }
      if (inserted.success.length === 0) {
        // Lost the creating race to another replica: roll our duplicate back
        // and join the winner's snapshot.
        if (deps.deleteEnabled) yield* rollbackRemote
        const winner = yield* tx
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
        if (winner[0]?.source_sandbox_id === sandboxID) return winner[0].id
        // Our remote snapshot may already be deleted. Never return that ID
        // as a successful checkpoint; the source must survive and retry.
        return yield* Effect.fail(new Error(`Snapshot creation winner settled; retry: ${sessionID}`))
      }
      return info.id
    }))

  /**
   * Wait for a snapshot to settle. Ready → mark ready; retain older recovery points.
   * Failed/timeout → mark failed (timeout keeps `creating` for gc to reconcile;
   * the caller must keep the source sandbox alive while a snapshot is still
   * Creating — killing it mid-commit fails the snapshot).
   */
  const awaitSnapshot = (sessionID: string, snapshotID: string, waitMs = deps.waitMs) =>
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis
      const deadline = startedAt + waitMs
      let last: { reason?: string; message?: string } | null = null
      let consecutiveErrors = 0
      while ((yield* Clock.currentTimeMillis) < deadline) {
        const statusExit = yield* Effect.tryPromise({
          try: async () => (await manager.getSnapshot(snapshotID)).status,
          catch: (cause) => new Error(`getSnapshot failed: ${String(cause)}`),
        }).pipe(Effect.result)
        if (statusExit._tag === "Success") {
          consecutiveErrors = 0
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
        } else {
          consecutiveErrors++
        }
        const now = yield* Clock.currentTimeMillis
        const remaining = deadline - now
        if (remaining > 0) {
          yield* Effect.sleep(Duration.millis(Math.min(remaining, snapshotPollIntervalMs(now - startedAt, consecutiveErrors))))
        }
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
  const gc = (sessionID?: string) =>
    Effect.gen(function* () {
      const now = Date.now()
      const expired = yield* db
        .select()
        .from(SessionSnapshotTable)
        .where(
          and(
            ...(sessionID ? [eq(SessionSnapshotTable.session_id, sessionID)] : []),
            or(
            eq(SessionSnapshotTable.state, "deleting"),
            and(
              inArray(SessionSnapshotTable.state, ["ready", "stale", "failed"]),
              lt(SessionSnapshotTable.time_created, now - deps.ttlMs),
            ),
            ),
          ),
        )
        .limit(50)
        .all()
      for (const row of expired) {
        if (row.session_id && (row.state === "ready" || row.state === "stale")) {
          const latest = yield* findRestorable(row.session_id)
          if (latest[0]?.id === row.id) continue // never GC the only/latest recovery point
        }
        yield* deleteSnapshot(row, row.state === "deleting" ? row.reason ?? "delete retry" : "ttl expired").pipe(
          Effect.ignore,
        )
      }

      const stuck = yield* db
        .select()
        .from(SessionSnapshotTable)
        .where(
            and(eq(SessionSnapshotTable.state, "creating"), lt(SessionSnapshotTable.time_created, now - deps.waitMs - 60_000), ...(sessionID ? [eq(SessionSnapshotTable.session_id, sessionID)] : [])),
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
