export * as SandboxSnapshotOperation from "./snapshot-operation.js"

import { randomUUID } from "node:crypto"
import { and, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm"
import { Effect } from "effect"
import {
  SnapshotOperationTable,
  SnapshotRefreshOperationTable,
  type OperationKind,
  type OperationState,
} from "./snapshot.sql.js"

const LEASE_MS = 5 * 60_000
export const MAX_ATTEMPTS = 5
const BASE_BACKOFF_MS = 30_000
const MAX_BACKOFF_MS = 10 * 60_000
const RETENTION_MS = 7 * 24 * 60 * 60_000

type Row = typeof SnapshotOperationTable.$inferSelect
export type OperationRow = Row
type Queue = "destroy" | "refresh"
type Table = typeof SnapshotOperationTable

/**
 * PostgreSQL-shared durable queue. Claims use conditional updates rather than
 * process-local locks; fencing tokens make all later writes conditional on the
 * exact lease generation that performed the work.
 */
export function create(dbInput: unknown, queue: Queue) {
  const table: Table = (queue === "refresh" ? SnapshotRefreshOperationTable : SnapshotOperationTable) as never
  const owner = randomUUID()
  const db = dbInput as {
    select: () => {
      from: (table: Table) => {
        where: (condition: unknown) => {
          orderBy: (order: unknown) => {
            limit: (count: number) => { all: () => Effect.Effect<Row[]> }
            all: () => Effect.Effect<Row[]>
          }
          limit: (count: number) => { all: () => Effect.Effect<Row[]> }
          all: () => Effect.Effect<Row[]>
        }
        all: () => Effect.Effect<Row[]>
      }
    }
    insert: (table: Table) => {
      values: (values: Record<string, unknown>) => {
        onConflictDoNothing: () => { run: () => Effect.Effect<unknown> }
      }
    }
    update: (table: Table) => {
      set: (values: Record<string, unknown>) => {
        where: (condition: unknown) => { returning: (fields: Record<string, unknown>) => { all: () => Effect.Effect<Row[]> } }
      }
    }
    delete: (table: Table) => { where: (condition: unknown) => { run: () => Effect.Effect<unknown> } }
  }

  const findActive = (sessionID: string, sandboxID: string, kind: OperationKind) =>
    db
      .select()
      .from(table)
      .where(
        and(
          eq(table.session_id, sessionID),
          eq(table.sandbox_id, sandboxID),
          eq(table.kind, kind),
          inArray(table.state, ["pending", "running"]),
        ),
      )
      .limit(1)
      .all()

  const enqueue = (input: { sessionID: string; sandboxID: string; kind: OperationKind }) =>
    Effect.gen(function* () {
      const expectedKind = queue === "destroy" ? "snapshot_destroy" : "snapshot_refresh"
      if (input.kind !== expectedKind) return yield* Effect.fail(new Error(`Wrong operation queue: ${input.kind}`))
      const id = randomUUID()
      const now = Date.now()
      yield* db
        .insert(table)
        .values({
          id,
          session_id: input.sessionID,
          sandbox_id: input.sandboxID,
          kind: input.kind,
          state: "pending",
          attempts: 0,
          next_retry_at: null,
          lease_owner: null,
          lease_until: null,
          fencing_token: 0,
          error: null,
          time_created: now,
          time_updated: now,
        })
        .onConflictDoNothing()
        .run()
      const active = yield* findActive(input.sessionID, input.sandboxID, input.kind)
      return active[0]?.id ?? id
    })

  const claim = (sessionID?: string) =>
    Effect.gen(function* () {
      const now = Date.now()
      const candidates = yield* db
        .select()
        .from(table)
        .where(
          and(
            ...(sessionID ? [eq(table.session_id, sessionID)] : []),
            or(
            and(eq(table.state, "pending"), or(isNull(table.next_retry_at), lt(table.next_retry_at, now))),
            and(eq(table.state, "running"), lt(table.lease_until, now)),
            ),
          ),
        )
        .orderBy(table.time_created)
        .limit(20)
        .all()
      for (const row of candidates) {
        const stateCondition =
          row.state === "pending"
            ? and(eq(table.state, "pending"), or(isNull(table.next_retry_at), lt(table.next_retry_at, now)))
            : and(
                eq(table.state, "running"),
                row.lease_until == null ? isNull(table.lease_until) : eq(table.lease_until, row.lease_until),
                lt(table.lease_until, now),
              )
        const claimed = yield* db
          .update(table)
          .set({
            state: "running" satisfies OperationState,
            lease_owner: owner,
            lease_until: now + LEASE_MS,
            attempts: sql`${table.attempts} + 1`,
            fencing_token: sql`${table.fencing_token} + 1`,
            time_updated: now,
          })
          .where(and(eq(table.id, row.id), stateCondition))
          .returning({ id: table.id })
          .all()
        if (claimed.length === 0) continue
        return { ...row, state: "running" as const, lease_owner: owner, lease_until: now + LEASE_MS,
          attempts: row.attempts + 1, fencing_token: row.fencing_token + 1 }
      }
      return null
    })

  const heartbeat = (id: string, token: number) =>
    db
      .update(table)
      .set({ lease_until: Date.now() + LEASE_MS, time_updated: Date.now() })
      .where(and(eq(table.id, id), eq(table.lease_owner, owner), eq(table.fencing_token, token), eq(table.state, "running"), gt(table.lease_until, Date.now())))
      .returning({ id: table.id })
      .all()
      .pipe(Effect.map((rows) => rows.length > 0))

  const complete = (id: string, token: number) =>
    db
      .update(table)
      .set({ state: "done", lease_owner: null, lease_until: null, error: null, time_updated: Date.now() })
      .where(and(eq(table.id, id), eq(table.lease_owner, owner), eq(table.fencing_token, token), eq(table.state, "running"), gt(table.lease_until, Date.now())))
      .returning({ id: table.id })
      .all()
      .pipe(Effect.map((rows) => rows.length > 0))

  const fail = (id: string, token: number, reason: string, attempts: number) => {
    const now = Date.now()
    // The backoff multiplier is computed in JS: `1 << attempts` in SQL is not
    // portable (PostgreSQL rejects `integer << bigint` on the bigint column).
    const capped = Math.min(attempts, 10)
    const backoffMs = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** capped)
    return db
      .update(table)
      .set({
        state: sql`CASE WHEN ${table.attempts} >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'pending' END`,
        next_retry_at: sql`CASE WHEN ${table.attempts} >= ${MAX_ATTEMPTS} THEN ${table.next_retry_at} ELSE ${now + backoffMs} END`,
        lease_owner: null,
        lease_until: null,
        error: reason,
        time_updated: now,
      })
      .where(and(eq(table.id, id), eq(table.lease_owner, owner), eq(table.fencing_token, token), eq(table.state, "running"), gt(table.lease_until, now)))
      .returning({ id: table.id })
      .all()
      .pipe(Effect.map((rows) => rows.length > 0))
  }

  const retention = (now = Date.now()) =>
    db.delete(table).where(and(inArray(table.state, ["done", "failed"]), lt(table.time_updated, now - RETENTION_MS))).run()

  /** A successful CLEAN check also coalesces repeated scans for this generation. */
  const checkedSince = (sessionID: string, sandboxID: string, cutoff: number) =>
    db.select().from(table)
      .where(and(eq(table.session_id, sessionID), eq(table.sandbox_id, sandboxID), eq(table.state, "done"), gt(table.time_updated, cutoff)))
      .limit(1).all().pipe(Effect.map((rows) => rows.length > 0))

  /** Session-scoped operation counts by state for observability (GET /snapshot/stats parity). */
  const stats = (sessionID: string) =>
    db
      .select()
      .from(table)
      .where(eq(table.session_id, sessionID))
      .all()
      .pipe(
        Effect.map((rows) => {
          const byState: Record<string, number> = {}
          for (const row of rows) byState[row.state] = (byState[row.state] ?? 0) + 1
          return { byState, total: rows.length }
        }),
        Effect.catch(() => Effect.succeed({ byState: {}, total: 0 })),
      )

  return { enqueue, claim, heartbeat, complete, fail, retention, stats, checkedSince, findActive, owner }
}

export type SnapshotOperations = ReturnType<typeof create>
