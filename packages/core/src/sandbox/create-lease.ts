export * as SandboxCreateLease from "./create-lease.js"

import { randomUUID } from "node:crypto"
import { and, eq, like, lt, or, sql } from "drizzle-orm"
import { Effect } from "effect"
import { SandboxTable } from "./sql.js"

/**
 * Cross-instance create arbitration (see docs/test-cases/sandbox/
 * sandbox-create-background.md "multi-replica concurrent create").
 *
 * The in-process `creates` single-flight only deduplicates callers inside one
 * server process. Two replicas sharing PostgreSQL used to each run
 * `Sandbox.create` for the same session, leaking one remote sandbox. This
 * lease arbitrates on the existing `sandbox` row (unique `session_id`):
 *
 * - `claim` inserts/updates the row to `state='creating', id='creating-<owner>'`.
 *   Only one caller wins; late or crashed holders are taken over after the
 *   lease expires (time_updated is refreshed by `heartbeat`).
 * - The loser polls until the winner persists the real sandbox id, then
 *   reconnects to that sandbox instead of creating its own.
 * - `release` marks a failed attempt back to `destroyed` so waiters retry
 *   immediately.
 */

export type Claim =
  | { readonly _tag: "claimed" }
  | { readonly _tag: "running"; readonly sandboxID: string }
  | { readonly _tag: "wait"; readonly holderID: string }

const CREATING_PREFIX = "creating-"
const PENDING_PREFIX = "pending-"

export const creatingID = (owner: string) => `${CREATING_PREFIX}${owner}`
export const isCreatingID = (id: string) => id.startsWith(CREATING_PREFIX)
export const isPendingID = (id: string) => id.startsWith(PENDING_PREFIX)

// The loose drizzle handle keeps this module testable against PG without
// pulling the provider layer; provider.ts passes its Effect-flavored db.
type Db = {
  insert: (table: typeof SandboxTable) => {
    values: (values: Record<string, unknown>) => {
      onConflictDoUpdate: (config: {
        target: unknown
        set: Record<string, unknown>
        setWhere?: unknown
      }) => { returning: (fields: Record<string, unknown>) => { all: () => Effect.Effect<Array<Record<string, unknown>>> } }
    }
  }
  update: (table: typeof SandboxTable) => {
    set: (values: Record<string, unknown>) => {
      where: (condition: unknown) => {
        returning: (fields: Record<string, unknown>) => { all: () => Effect.Effect<Array<Record<string, unknown>>> }
        run: () => Effect.Effect<unknown>
      }
    }
  }
  select: () => {
    from: (table: typeof SandboxTable) => {
      where: (condition: unknown) => { limit: (n: number) => { all: () => Effect.Effect<Array<Record<string, unknown>>> } }
    }
  }
}

export interface Deps {
  readonly db: unknown
  /** Lease window; a crashed creator is taken over after it expires. */
  readonly leaseMs: number
  readonly host: string
}

export function create(deps: Deps) {
  const db = deps.db as Db
  const owner = randomUUID()

  const row = (sessionID: string) =>
    db
      .select()
      .from(SandboxTable)
      .where(eq(SandboxTable.session_id, sessionID))
      .limit(1)
      .all()

  /**
   * Try to become the creator. The conflict update only fires when the row is
   * terminal (`destroyed`) or the holder's lease expired; a healthy `creating`
   * row or a persisted `running` row leaves the row untouched.
   */
  const claim = (sessionID: string) =>
    Effect.gen(function* () {
      const now = Date.now()
      const inserted = yield* db
        .insert(SandboxTable)
        .values({
          id: creatingID(owner),
          session_id: sessionID,
          host: deps.host,
          state: "creating",
          keep_alive: false,
        })
        .onConflictDoUpdate({
          target: SandboxTable.session_id,
          set: { id: creatingID(owner), state: "creating", host: deps.host, time_updated: now },
          setWhere: or(
            eq(SandboxTable.state, "destroyed"),
            and(
              eq(SandboxTable.state, "creating"),
              lt(SandboxTable.time_updated, now - deps.leaseMs),
            ),
          ),
        })
        .returning({ id: SandboxTable.id, state: SandboxTable.state })
        .all()
      const current = inserted[0]
      if (current && current.id === creatingID(owner)) return { _tag: "claimed" } as const
      if (current && current.state === "running" && !isCreatingID(String(current.id)) && !isPendingID(String(current.id)))
        return { _tag: "running", sandboxID: String(current.id) } as const
      if (current && current.state === "creating") return { _tag: "wait", holderID: String(current.id) } as const
      // Row is running/pending under someone else: treat as wait; the caller
      // re-checks the row and falls back to the normal resolve path.
      const existing = yield* row(sessionID)
      const found = existing[0]
      if (!found) return { _tag: "wait", holderID: "unknown" } as const
      if (found.state === "running" && !isCreatingID(String(found.id)) && !isPendingID(String(found.id)))
        return { _tag: "running", sandboxID: String(found.id) } as const
      return { _tag: "wait", holderID: String(found.id) } as const
    })

  /** Refresh the lease while a long create (image pull) is in flight. */
  const heartbeat = (sessionID: string) =>
    db
      .update(SandboxTable)
      .set({ time_updated: Date.now() })
      .where(and(eq(SandboxTable.session_id, sessionID), eq(SandboxTable.id, creatingID(owner))))
      .run()
      .pipe(Effect.as(true))

  /**
   * Persist the created sandbox id. The CAS on our own creating row keeps a
   * late takeover from overwriting another creator's result.
   */
  const complete = (sessionID: string, sandboxID: string) =>
    db
      .update(SandboxTable)
      .set({ id: sandboxID, state: "running", host: deps.host, time_updated: Date.now() })
      .where(and(eq(SandboxTable.session_id, sessionID), eq(SandboxTable.id, creatingID(owner))))
      .returning({ id: SandboxTable.id })
      .all()
      .pipe(Effect.map((rows) => rows.length > 0))

  /** Give the lease back after a failed create so waiters retry immediately. */
  const release = (sessionID: string) =>
    db
      .update(SandboxTable)
      .set({ state: "destroyed", time_updated: Date.now() })
      .where(and(eq(SandboxTable.session_id, sessionID), eq(SandboxTable.id, creatingID(owner))))
      .run()

  /** Latest row snapshot for waiters. */
  const latest = (sessionID: string) => row(sessionID)

  return { owner, claim, heartbeat, complete, release, latest }
}

export type CreateLease = ReturnType<typeof create>

/** GC hook: rows stuck in `creating` past the lease converge to `destroyed`. */
export const sweepStaleCreating = (dbInput: unknown, leaseMs: number, limit = 20) => {
  const db = dbInput as Db
  return db
    .update(SandboxTable)
    .set({ state: "destroyed", time_updated: Date.now() })
    .where(
      and(
        eq(SandboxTable.state, "creating"),
        lt(SandboxTable.time_updated, Date.now() - leaseMs),
        like(SandboxTable.id, `${CREATING_PREFIX}%`),
      ),
    )
    .run()
}
