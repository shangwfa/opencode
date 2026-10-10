export * as SessionExecutionLease from "./execution-lease.js"

import { and, eq, gt, lt, or, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import type { Database } from "../database/database.js"
import { SessionSchema } from "./schema.js"
import { SessionExecutionLeaseTable } from "./sql.js"

export class BusyError extends Schema.TaggedError<BusyError>()("SessionExecutionLease.BusyError", {
  sessionID: SessionSchema.ID,
  ownerID: Schema.String,
}) {
  override get message() {
    return `Execution lease for ${this.sessionID} is held by ${this.ownerID}`
  }
}

/** The owner no longer holds the recorded epoch: its writes must stop or roll back. */
export class LostError extends Schema.TaggedError<LostError>()("SessionExecutionLease.LostError", {
  sessionID: SessionSchema.ID,
  ownerID: Schema.String,
  epoch: Schema.Number,
}) {
  override get message() {
    return `Execution lease for ${this.sessionID} moved on from epoch ${this.epoch} (was ${this.ownerID})`
  }
}

export interface Lease {
  readonly ownerID: string
  readonly epoch: number
}

export interface Interface {
  /** Takes over an absent or expired lease, or refreshes this owner's lease. */
  readonly acquire: (sessionID: SessionSchema.ID) => Effect.Effect<Lease, BusyError>
  /** Extends the expiry. Fails when the recorded owner or epoch moved on. */
  readonly renew: (sessionID: SessionSchema.ID, lease: Lease) => Effect.Effect<void, LostError>
  /**
   * Deletes the lease only when the recorded owner and epoch still match. Run
   * inside the terminal event's commit: a LostError rolls the whole event
   * transaction back, so a stale owner can never publish another owner's turn.
   */
  readonly releaseFenced: (sessionID: SessionSchema.ID, lease: Lease) => Effect.Effect<void, LostError>
  /** Sessions whose lease is still unexpired, for sweep pre-filtering. */
  readonly held: () => Effect.Effect<ReadonlyArray<SessionSchema.ID>>
}

export const DefaultTtlMs = 60_000
export const DefaultRenewMs = 15_000

export interface Options {
  readonly ttlMs: number
  readonly renewMs: number
}

const positive = (value: string | undefined, fallback: number) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/** Tunable for tests and load profiling; the defaults are unvalidated starting points. */
export const makeOptions = (env: Readonly<Record<string, string | undefined>> = process.env): Options => ({
  ttlMs: positive(env["OPENCODE_EXECUTION_LEASE_TTL_MS"], DefaultTtlMs),
  renewMs: positive(env["OPENCODE_EXECUTION_LEASE_RENEW_MS"], DefaultRenewMs),
})

export const make = (db: Database.Interface["db"], ownerID: string, options?: Partial<Options>) => {
  const ttlMs = options?.ttlMs ?? DefaultTtlMs
  const table = SessionExecutionLeaseTable

  const acquire = Effect.fn("SessionExecutionLease.acquire")(function* (sessionID: SessionSchema.ID) {
    const now = Date.now()
    // The transaction decides atomically between success and Busy; anything
    // else is an infrastructure defect.
    const outcome = yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          // Fresh rows insert at epoch 0; the conditional update promotes every
          // acquire — fresh, same-owner refresh, or expired takeover — to the
          // next monotonic epoch within the same locked transaction.
          yield* tx
            .insert(table)
            .values({
              session_id: sessionID,
              owner_id: ownerID,
              epoch: 0,
              time_acquired: now,
              time_expires: now + ttlMs,
            })
            .onConflictDoNothing()
            .run()
            .pipe(Effect.orDie)
          const rows = yield* tx
            .update(table)
            .set({
              owner_id: ownerID,
              epoch: sql`${table.epoch} + 1`,
              time_acquired: now,
              time_expires: now + ttlMs,
            })
            .where(and(eq(table.session_id, sessionID), or(eq(table.owner_id, ownerID), lt(table.time_expires, now))))
            .returning({ epoch: table.epoch })
            .all()
            .pipe(Effect.orDie)
          const epoch = rows[0]?.epoch
          if (epoch !== undefined) return { ok: true as const, lease: { ownerID, epoch } satisfies Lease }
          const current = yield* tx
            .select({ ownerID: table.owner_id })
            .from(table)
            .where(eq(table.session_id, sessionID))
            .get()
            .pipe(Effect.orDie)
          return {
            ok: false as const,
            busy: new BusyError({ sessionID, ownerID: current?.ownerID ?? "unknown" }),
          }
        }),
      )
      .pipe(Effect.orDie)
    if (!outcome.ok) return yield* outcome.busy
    return outcome.lease
  })

  const renew = Effect.fn("SessionExecutionLease.renew")(function* (sessionID: SessionSchema.ID, lease: Lease) {
    const rows = yield* db
      .update(table)
      .set({ time_expires: Date.now() + ttlMs })
      .where(and(eq(table.session_id, sessionID), eq(table.owner_id, lease.ownerID), eq(table.epoch, lease.epoch)))
      .returning({ id: table.session_id })
      .all()
      .pipe(Effect.orDie)
    if (rows.length === 0) return yield* new LostError({ sessionID, ...lease })
  })

  const releaseFenced = Effect.fn("SessionExecutionLease.releaseFenced")(function* (
    sessionID: SessionSchema.ID,
    lease: Lease,
  ) {
    const rows = yield* db
      .delete(table)
      .where(and(eq(table.session_id, sessionID), eq(table.owner_id, lease.ownerID), eq(table.epoch, lease.epoch)))
      .returning({ id: table.session_id })
      .all()
      .pipe(Effect.orDie)
    if (rows.length === 0) return yield* new LostError({ sessionID, ...lease })
  })

  const held = Effect.fn("SessionExecutionLease.held")(function* () {
    const rows = yield* db
      .select({ id: table.session_id })
      .from(table)
      .where(gt(table.time_expires, Date.now()))
      .all()
      .pipe(Effect.orDie)
    return rows.map((row) => row.id)
  })

  return { acquire, renew, releaseFenced, held } satisfies Interface
}

/** Owner-agnostic live-lease snapshot, for sweep pre-filtering. */
export const holds = (db: Database.Interface["db"]) =>
  db
    .select({ id: SessionExecutionLeaseTable.session_id })
    .from(SessionExecutionLeaseTable)
    .where(gt(SessionExecutionLeaseTable.time_expires, Date.now()))
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.map((row) => row.id)),
    )
