export * as Hitl from "./index.js"

import { and, eq, inArray, lt, ne } from "drizzle-orm"
import { Cause, Effect, Option } from "effect"
import { Database } from "../database/database.js"
import type { Session } from "@opencode/schema/session"
import { HitlRequestTable } from "./sql.js"

/**
 * Persistence for HITL pending state, writing the v1-compatible
 * `hitl_request` table (v1 hitl/store parity). v2's form-based questions map
 * to kind="question" and permission asks to kind="permission"; settle maps
 * answered→replied (close_reason answered-delivered) and cancelled→closed
 * (close_reason shutdown/instance-restart).
 *
 * Best-effort by design: persistence failures log and never break the
 * in-memory interaction — the table is a restart-recovery mirror, not the
 * source of truth. All transitions are CAS on status=pending.
 *
 * The v2 core database is Effect-based drizzle, so every statement returns an
 * Effect that must be yielded; failures are caught and downgraded to logs.
 */

/** v2 ask surface → v1 kind value. */
export type Kind = "question" | "permission"
export type Status = "pending" | "replied" | "rejected" | "closed"
export type CloseReason = "instance-restart" | "shutdown" | "answered-delivered" | "decision-delivered"

export interface Row {
  readonly id: string
  readonly kind: Kind
  readonly directory: string
  readonly user_id: string
  readonly session_id: string
  readonly owner_id: string
  readonly status: Status
  readonly payload: Record<string, unknown>
  readonly result: Record<string, unknown> | null
  readonly close_reason: CloseReason | null
  readonly lease_until: number
}

export interface NewPending {
  readonly id: string
  readonly kind: Kind
  readonly directory: string
  readonly userID?: string
  /** Kept as plain string: form session ids include the "global" elicitation escape hatch, which is not a branded SessionID. */
  readonly sessionID: string
  readonly ownerID: string
  readonly payload: Record<string, unknown>
}

export interface SettleInput {
  readonly status: Exclude<Status, "pending">
  readonly result?: Record<string, unknown>
  readonly closeReason?: CloseReason
  /**
   * Owning user when the caller acts on behalf of one: a mismatch reads as
   * "not found" instead of settling (v1's cross-tenant submit guard).
   * Omit for internal sweeps (session removal, salvage) that clean up across users.
   */
  readonly userID?: string
}

const LEASE_TTL_MS = 60_000

/**
 * Wraps one tick of a background loop: real failures log and let the loop
 * continue, while interruption propagates so the loop dies with its scope —
 * a blanket catchCause here would wedge scope teardown (eviction timeouts).
 */
export const loopTick = <A, E>(effect: Effect.Effect<A, E, never>, label: string): Effect.Effect<void> =>
  effect.pipe(
    Effect.asVoid,
    Effect.catchCause((cause) =>
      cause.reasons.some(Cause.isInterruptReason) ? Effect.interrupt : Effect.logWarning(label, cause),
    ),
  )

/** Half the lease, so a live holder renews well before closeExpired claims it. */
export const LEASE_RENEW_MS = LEASE_TTL_MS / 2

/**
 * Grace after lease expiry before a dead owner's row may be swept. Recovered
 * asks (restored by a new instance) are not renewed, so this is the window in
 * which a user can still answer a restart-surviving ask (v1: lease + grace +
 * scan ≈ 150s).
 */
export const SWEEP_GRACE_MS = 90_000

let cachedOwnerID: string | undefined

/**
 * Identity stamped on rows this process owns. Explicit config wins; otherwise a
 * per-process id keeps two instances without OPENCODE_INSTANCE_ID from renewing
 * and expiring each other's live asks.
 */
export const ownerID = (): string => {
  cachedOwnerID ??= process.env["OPENCODE_INSTANCE_ID"] ?? `local-${crypto.randomUUID()}`
  return cachedOwnerID
}

/**
 * Owning user for a HITL ask, read from the most recent user message's
 * metadata (v1 records the identity on the requesting user message). An empty
 * string means the public/unattributed bucket, matching v1's PUBLIC_USER_ID.
 */
export const userIDFromMessages = (
  messages: ReadonlyArray<{ readonly type: string; readonly metadata?: Record<string, unknown> }>,
): string => {
  const value = messages.findLast((message) => message.type === "user")?.metadata?.["userId"]
  return typeof value === "string" ? value.trim().slice(0, 128) : ""
}

/**
 * Runs `use` with the ambient Database when the host graph provides one;
 * persistence is optional (Location-scoped services may live outside the
 * database graph), so absence skips the mirror silently.
 */
const withDb = <A, E, R>(
  label: string,
  use: (db: Database.Interface["db"]) => Effect.Effect<A, E, R>,
): Effect.Effect<void, never, R> =>
  Effect.serviceOption(Database.Service).pipe(
    Effect.flatMap((option) => (Option.isNone(option) ? Effect.void : use(option.value.db))),
    Effect.asVoid,
    Effect.catchCause((cause) => Effect.logWarning(`${label} failed`, cause).pipe()),
  )

export const insertPending = (input: NewPending): Effect.Effect<void> =>
  withDb("hitl insertPending", (db) =>
    Effect.gen(function* () {
      const now = Date.now()
      yield* db
        .insert(HitlRequestTable)
        .values([
          {
            id: input.id,
            kind: input.kind,
            directory: input.directory,
            user_id: input.userID ?? "",
            session_id: input.sessionID,
            owner_id: input.ownerID,
            status: "pending",
            payload: input.payload,
            lease_until: now + LEASE_TTL_MS,
            time_created: now,
            time_updated: now,
          },
        ])
        .onConflictDoUpdate({
          target: HitlRequestTable.id,
          set: { status: "pending", payload: input.payload, lease_until: now + LEASE_TTL_MS, time_updated: now },
        })
        .run()
    }),
  )

/** CAS: pending → terminal. No-op when the row is already terminal. */
export const settle = (id: string, input: SettleInput): Effect.Effect<void> =>
  withDb("hitl settle", (db) =>
    Effect.gen(function* () {
      const now = Date.now()
      yield* db
        .update(HitlRequestTable)
        .set({
          status: input.status,
          ...(input.result === undefined ? {} : { result: input.result }),
          ...(input.closeReason === undefined ? {} : { close_reason: input.closeReason }),
          time_updated: now,
        })
        .where(
          and(
            eq(HitlRequestTable.id, id),
            eq(HitlRequestTable.status, "pending"),
            ...(input.userID === undefined ? [] : [eq(HitlRequestTable.user_id, input.userID)]),
          ),
        )
        .run()
    }),
  )

/**
 * Rows still pending (optionally per kind/directory) — boot recovery source.
 * `undefined` means no database is configured, so callers can distinguish
 * "nothing pending" from "cannot verify" when reconciling local state.
 */
export const listPending = (
  filter?: { readonly kind?: Kind; readonly directory?: string; readonly userID?: string },
): Effect.Effect<ReadonlyArray<Row> | undefined> =>
  Effect.serviceOption(Database.Service).pipe(
    Effect.flatMap((option) =>
      Option.isNone(option)
        ? Effect.succeed(undefined)
        : Effect.gen(function* () {
            const rows = yield* option.value.db
              .select()
              .from(HitlRequestTable)
              .where(
                and(
                  eq(HitlRequestTable.status, "pending"),
                  filter?.kind === undefined ? undefined : eq(HitlRequestTable.kind, filter.kind),
                  filter?.directory === undefined ? undefined : eq(HitlRequestTable.directory, filter.directory),
                  filter?.userID === undefined ? undefined : eq(HitlRequestTable.user_id, filter.userID),
                ),
              )
              .all()
            return rows as unknown as ReadonlyArray<Row>
          }),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("hitl listPending failed", cause).pipe(Effect.as([] as ReadonlyArray<Row>)),
    ),
  )

/**
 * Ids whose row reached a terminal status. Reconciliation drops only these:
 * an absent row (cascade-deleted with its session, or written by a host
 * without persistence) is not evidence that the local ask was settled.
 */
export const settledIds = (kind: Kind, directory: string): Effect.Effect<ReadonlyArray<string> | undefined> =>
  Effect.serviceOption(Database.Service).pipe(
    Effect.flatMap((option) =>
      Option.isNone(option)
        ? Effect.succeed(undefined)
        : option.value.db
            .select({ id: HitlRequestTable.id })
            .from(HitlRequestTable)
            .where(
              and(
                eq(HitlRequestTable.kind, kind),
                eq(HitlRequestTable.directory, directory),
                ne(HitlRequestTable.status, "pending"),
              ),
            )
            .all()
            .pipe(Effect.map((rows) => rows.map((row) => row.id))),
    ),
    Effect.catchCause((cause) => Effect.logWarning("hitl settledIds failed", cause).pipe(Effect.as(undefined))),
  )

/** Single row by id, when it still exists (reply fallback across graphs). */
export const row = (id: string): Effect.Effect<Row | undefined> =>
  Effect.serviceOption(Database.Service).pipe(
    Effect.flatMap((option) =>
      Option.isNone(option)
        ? Effect.succeed(undefined)
        : option.value.db.select().from(HitlRequestTable).where(eq(HitlRequestTable.id, id)).get(),
    ),
    Effect.catchCause((cause) => Effect.logWarning("hitl row failed", cause).pipe(Effect.as(undefined))),
  )

/** Delete every hitl_request row of a session — v1's FK ON DELETE CASCADE. */
export const deleteBySession = (sessionID: Session.ID): Effect.Effect<void> =>
  withDb("hitl deleteBySession", (db) =>
    Effect.gen(function* () {
      yield* db.delete(HitlRequestTable).where(eq(HitlRequestTable.session_id, sessionID)).run()
    }),
  )

/** Close rows whose lease expired (owning instance died) — v1 instance-restart. */
export const closeExpired = (now = Date.now()): Effect.Effect<void> =>
  withDb("hitl closeExpired", (db) =>
    Effect.gen(function* () {
      yield* db
        .update(HitlRequestTable)
        .set({ status: "closed", close_reason: "instance-restart", time_updated: now })
        .where(and(eq(HitlRequestTable.status, "pending"), lt(HitlRequestTable.lease_until, now)))
        .run()
    }),
  )

/** Renew the lease on a row this instance holds. */
export const renew = (id: string, ownerID: string, now = Date.now()): Effect.Effect<void> =>
  withDb("hitl renew", (db) =>
    Effect.gen(function* () {
      yield* db
        .update(HitlRequestTable)
        .set({ lease_until: now + LEASE_TTL_MS, time_updated: now })
        .where(
          and(
            eq(HitlRequestTable.id, id),
            eq(HitlRequestTable.owner_id, ownerID),
            eq(HitlRequestTable.status, "pending"),
          ),
        )
        .run()
    }),
  )

/**
 * Keeps this holder's pending rows leased for as long as they stay live. Without
 * it a suspended ask's row expires after LEASE_TTL_MS and another instance's
 * boot-time closeExpired would reclaim a live request as instance-restart.
 * Renews only ids the caller still holds, so co-located instances never fight.
 */
export const renewal = (
  ids: () => Effect.Effect<ReadonlyArray<string>>,
  owner = ownerID(),
): Effect.Effect<never, never, never> =>
  Effect.forever(
    Effect.sleep(LEASE_RENEW_MS).pipe(
      Effect.andThen(ids()),
      Effect.flatMap((list) =>
        loopTick(Effect.forEach(list, (id) => renew(id, owner), { discard: true }), "hitl renewal failed"),
      ),
    ),
  )
/**
 * A dangling ask whose owning instance died (lease expired) while its tool part
 * may still be running. The runner's terminal tool events only move `running`
 * parts, so re-publishing the right one is the CAS.
 */
export interface SweepAction {
  readonly id: string
  readonly sessionID: string
  readonly messageID: string
  readonly toolID: string
  readonly status: "pending" | "replied" | "rejected"
  /** Model-readable text for a backfilled answer (replied only). */
  readonly answer?: string
}

/**
 * Rows whose owner stopped renewing its lease. A live owner renews every
 * LEASE_RENEW_MS (see `renewal`), so an expired lease means the holder died and
 * the ask can never be answered by it.
 */
export const sweepables = (kind: Kind, now = Date.now()): Effect.Effect<ReadonlyArray<SweepAction>> =>
  Effect.serviceOption(Database.Service).pipe(
    Effect.flatMap((option) =>
      Option.isNone(option)
        ? Effect.succeed([] as ReadonlyArray<SweepAction>)
        : Effect.gen(function* () {
            const rows = yield* option.value.db
              .select()
              .from(HitlRequestTable)
              .where(
                and(
                  eq(HitlRequestTable.kind, kind),
                  lt(HitlRequestTable.lease_until, now - SWEEP_GRACE_MS),
                  inArray(HitlRequestTable.status, ["pending", "replied", "rejected"]),
                ),
              )
              .all()
            return rows.flatMap((row) => {
              const action = sweepAction(row)
              return action === undefined ? [] : [action]
            })
          }),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("hitl sweepables failed", cause).pipe(Effect.as([] as ReadonlyArray<SweepAction>)),
    ),
  )

function sweepAction(row: Row): SweepAction | undefined {
  const raw: unknown = row.payload
  const payload = typeof raw === "string" ? tryParse(raw) : raw
  if (payload === null || typeof payload !== "object") return undefined
  const locator = toolLocator(payload as Record<string, unknown>, row.kind)
  if (locator === undefined) return undefined
  const status = row.status as "pending" | "replied" | "rejected"
  const answer = status === "replied" ? answerText(row) : undefined
  return {
    id: row.id,
    sessionID: row.session_id,
    messageID: locator.messageID,
    toolID: locator.toolID,
    status,
    ...(answer === undefined ? {} : { answer }),
  }
}

/** question stores its locator under payload.metadata.tool; permission under payload.source. */
function toolLocator(
  payload: Record<string, unknown>,
  kind: Kind,
): { readonly messageID: string; readonly toolID: string } | undefined {
  const raw =
    kind === "question"
      ? (payload["metadata"] as { tool?: unknown } | undefined)?.tool
      : (payload["source"] as unknown)
  if (raw === null || typeof raw !== "object") return undefined
  const messageID = (raw as { messageID?: unknown }).messageID
  const toolID = (raw as { id?: unknown }).id
  if (typeof messageID !== "string" || typeof toolID !== "string") return undefined
  return { messageID, toolID }
}

/** Best-effort model-readable rendering of a submitted answer or decision. */
function answerText(row: Row): string | undefined {
  const result = row.result as Record<string, unknown> | null | undefined
  if (result === null || result === undefined) return undefined
  if (row.kind === "question" && result["answer"] !== undefined) return JSON.stringify(result["answer"])
  const reply = result["reply"]
  if (typeof reply === "string") return reply === "reject" ? "The user declined this action." : `The user approved this action (${reply}).`
  return undefined
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * Rows answered but never consumed by their run (holder died before delivery).
 * No lease condition: the answer is already committed, so backfilling is always
 * safe — the terminal tool event only moves `running` parts, and a live run
 * that later settles its own part simply no-ops the CAS.
 */
export const backfillables = (kind: Kind): Effect.Effect<ReadonlyArray<SweepAction>> =>
  Effect.serviceOption(Database.Service).pipe(
    Effect.flatMap((option) =>
      Option.isNone(option)
        ? Effect.succeed([] as ReadonlyArray<SweepAction>)
        : Effect.gen(function* () {
            const rows = yield* option.value.db
              .select()
              .from(HitlRequestTable)
              .where(
                and(
                  eq(HitlRequestTable.kind, kind),
                  inArray(HitlRequestTable.status, ["replied", "rejected"]),
                ),
              )
              .all()
            return rows.flatMap((row) => {
              const action = sweepAction(row)
              return action === undefined ? [] : [action]
            })
          }),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("hitl backfillables failed", cause).pipe(Effect.as([] as ReadonlyArray<SweepAction>)),
    ),
  )

/** Moves a backfilled replied row to its v1 terminal shape. */
export const markBackfilled = (id: string, now = Date.now()): Effect.Effect<void> =>
  withDb("hitl markBackfilled", (db) =>
    Effect.gen(function* () {
      yield* db
        .update(HitlRequestTable)
        .set({ status: "closed", close_reason: "answered-delivered", time_updated: now })
        .where(and(eq(HitlRequestTable.id, id), eq(HitlRequestTable.status, "replied")))
        .run()
    }),
  )

/**
 * Marks a swept row terminal. CAS on the expired-lease predicate so a row that
 * somehow got renewed (or already swept by another instance) is left alone.
 */
export const markSwept = (
  id: string,
  status: "closed" | "rejected",
  closeReason: "instance-restart" | "answered-delivered" | "decision-delivered",
  now = Date.now(),
): Effect.Effect<void> =>
  withDb("hitl markSwept", (db) =>
    Effect.gen(function* () {
      yield* db
        .update(HitlRequestTable)
        .set({ status, close_reason: closeReason, time_updated: now })
        .where(
          and(
            eq(HitlRequestTable.id, id),
            lt(HitlRequestTable.lease_until, now - SWEEP_GRACE_MS),
            inArray(HitlRequestTable.status, ["pending", "replied", "rejected"]),
          ),
        )
        .run()
    }),
  )
