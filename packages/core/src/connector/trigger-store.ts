export * as ConnectorTriggerStore from "./trigger-store.js"

import { and, asc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Connector } from "@opencode/connector/adapter"
import { ConnectorCrypto } from "@opencode/connector/adapter/crypto"
import {
  ConnectorTriggerEventTable,
  ConnectorTriggerReceiptTable,
  ConnectorTriggerScheduleTable,
} from "./sql.js"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Database } from "../database/database.js"

/** Reads the key per call: a missing key only fails trigger operations, never service construction. */
const codec = () => ConnectorCrypto.codec(process.env.OPENCODE_CONNECTOR_ENCRYPTION_KEY)

/** Internal signal that rolls back a receipt completion whose receipt already settled. */
class ReceiptSettled {
  readonly _tag = "ReceiptSettled"
}

const layer = Layer.effect(
  Connector.TriggerStore,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    type Stored = typeof ConnectorTriggerScheduleTable.$inferSelect
    /** Decrypts the token; a legacy plaintext-only row is rewritten as ciphertext (lazy migration). */
    const hydrate = (row: Stored) =>
      Effect.gen(function* () {
        const resolved = yield* Effect.sync(() =>
          ConnectorCrypto.resolveToken({ encrypted: row.engine_token_encrypted, plaintext: row.engine_token, codec: codec() }),
        )
        if (resolved.writeBack !== null) {
          yield* db
            .update(ConnectorTriggerScheduleTable)
            .set({ engine_token_encrypted: resolved.writeBack, engine_token: null })
            .where(eq(ConnectorTriggerScheduleTable.id, row.id))
            .run()
        }
        return {
          ...row,
          id: row.id as Connector.TriggerRow["id"],
          engine_token: resolved.token,
        } as Connector.TriggerRow
      })
    return Connector.TriggerStore.of({
      insert: (row) =>
        Effect.gen(function* () {
          const { engine_token, ...rest } = row
          const encrypted = engine_token === null ? null : yield* Effect.sync(() => codec().encrypt(engine_token))
          yield* db
            .insert(ConnectorTriggerScheduleTable)
            .values({ ...rest, engine_token: null, engine_token_encrypted: encrypted })
            .run()
        }).pipe(Effect.orDie),
      get: (id) =>
        db
          .select()
          .from(ConnectorTriggerScheduleTable)
          .where(eq(ConnectorTriggerScheduleTable.id, id))
          .all()
          .pipe(
            Effect.flatMap((rows) => (rows.length > 0 ? hydrate(rows[0]!) : Effect.succeed(undefined))),
            Effect.orDie,
          ),
      listBySession: (sessionID) =>
        db
          .select()
          .from(ConnectorTriggerScheduleTable)
          .where(eq(ConnectorTriggerScheduleTable.session_id, sessionID))
          .all()
          .pipe(Effect.flatMap((rows) => Effect.forEach(rows, hydrate)), Effect.orDie),
      delete: (id) =>
        db.delete(ConnectorTriggerScheduleTable).where(eq(ConnectorTriggerScheduleTable.id, id)).run().pipe(Effect.orDie),
      updateStatus: (id, status) =>
        db
          .update(ConnectorTriggerScheduleTable)
          .set({ status, time_updated: Date.now() })
          .where(eq(ConnectorTriggerScheduleTable.id, id))
          .run()
          .pipe(Effect.orDie),
      updateTokenState: (id, state) =>
        db
          .update(ConnectorTriggerScheduleTable)
          .set({ token_state: state, time_updated: Date.now() })
          .where(eq(ConnectorTriggerScheduleTable.id, id))
          .run()
          .pipe(Effect.orDie),
      // SKIP LOCKED semantics via lease CAS: the epoch bump inside the same UPDATE claim makes a
      // concurrent pod's identical claim fail its lease_until guard on the second attempt.
      claimDue: (now, leaseMs) =>
        db
          .update(ConnectorTriggerScheduleTable)
          .set({
            lease_epoch: sql`${ConnectorTriggerScheduleTable.lease_epoch} + 1`,
            lease_until: now + leaseMs,
            time_updated: now,
          })
          .where(
            and(
              eq(ConnectorTriggerScheduleTable.status, "active"),
              lte(ConnectorTriggerScheduleTable.next_run_at, now),
              lt(ConnectorTriggerScheduleTable.lease_until, now),
            ),
          )
          .returning()
          .all()
          .pipe(Effect.flatMap((rows) => Effect.forEach(rows, hydrate)), Effect.orDie),
      claim: (id, now, leaseMs) =>
        db
          .update(ConnectorTriggerScheduleTable)
          .set({
            lease_epoch: sql`${ConnectorTriggerScheduleTable.lease_epoch} + 1`,
            lease_until: now + leaseMs,
            time_updated: now,
          })
          .where(
            and(
              eq(ConnectorTriggerScheduleTable.id, id),
              eq(ConnectorTriggerScheduleTable.status, "active"),
              lt(ConnectorTriggerScheduleTable.lease_until, now),
            ),
          )
          .returning()
          .get()
          .pipe(Effect.flatMap((row) => (row === undefined ? Effect.succeed(undefined) : hydrate(row))), Effect.orDie),
      savePollPage: (input) =>
        db
          .transaction((tx) =>
            Effect.gen(function* () {
              // The epoch CAS runs first: a stale owner's page writes nothing, not even events.
              const advanced = yield* tx
                .update(ConnectorTriggerScheduleTable)
                .set({
                  checkpoint: input.checkpoint,
                  last_result: input.lastResult,
                  next_run_at: input.nextRunAt,
                  checkpoint_revision: sql`${ConnectorTriggerScheduleTable.checkpoint_revision} + 1`,
                  poll_attempts: 0,
                  time_updated: Date.now(),
                })
                .where(
                  and(
                    eq(ConnectorTriggerScheduleTable.id, input.id),
                    eq(ConnectorTriggerScheduleTable.lease_epoch, input.expectedEpoch),
                  ),
                )
                .returning({ id: ConnectorTriggerScheduleTable.id })
                .all()
              if (advanced.length === 0) return false
              for (const event of input.events) {
                yield* tx
                  .insert(ConnectorTriggerEventTable)
                  .values({
                    id: crypto.randomUUID(),
                    schedule_id: input.id,
                    delivery_key: event.deliveryKey,
                    payload: event.payload,
                    delivered_at: null,
                  })
                  .onConflictDoNothing({ target: [ConnectorTriggerEventTable.schedule_id, ConnectorTriggerEventTable.delivery_key] })
                  .run()
              }
              return true
            }),
          )
          .pipe(Effect.orDie),
      recordPollFailure: (input) =>
        db
          .update(ConnectorTriggerScheduleTable)
          .set({
            last_result: input.lastResult,
            next_run_at: input.nextRunAt,
            poll_attempts: sql`${ConnectorTriggerScheduleTable.poll_attempts} + 1`,
            ...(input.suspend ? { status: "suspended" } : {}),
            time_updated: Date.now(),
          })
          .where(
            and(
              eq(ConnectorTriggerScheduleTable.id, input.id),
              eq(ConnectorTriggerScheduleTable.lease_epoch, input.expectedEpoch),
            ),
          )
          .returning({ id: ConnectorTriggerScheduleTable.id })
          .all()
          .pipe(Effect.map((rows) => rows.length > 0), Effect.orDie),
      insertReceipt: (row) =>
        db
          .insert(ConnectorTriggerReceiptTable)
          .values(row)
          .onConflictDoNothing({ target: [ConnectorTriggerReceiptTable.schedule_id, ConnectorTriggerReceiptTable.dedup_key] })
          .returning({ id: ConnectorTriggerReceiptTable.id })
          .all()
          .pipe(Effect.map((rows) => rows.length > 0), Effect.orDie),
      findReceipt: (scheduleId, dedupKey) =>
        db
          .select()
          .from(ConnectorTriggerReceiptTable)
          .where(and(eq(ConnectorTriggerReceiptTable.schedule_id, scheduleId), eq(ConnectorTriggerReceiptTable.dedup_key, dedupKey)))
          .get()
          .pipe(Effect.orDie),
      claimStaleReceipts: (now, maxAttempts, reclaimMs) =>
        db
          .transaction((tx) =>
            Effect.gen(function* () {
              // Receipts that already spent every attempt park as failed instead of being claimed forever.
              yield* tx
                .update(ConnectorTriggerReceiptTable)
                .set({ state: "failed", time_updated: now })
                .where(
                  and(
                    eq(ConnectorTriggerReceiptTable.state, "received"),
                    lte(ConnectorTriggerReceiptTable.next_retry_at, now),
                    gte(ConnectorTriggerReceiptTable.attempts, maxAttempts),
                  ),
                )
                .run()
              return yield* tx
                .update(ConnectorTriggerReceiptTable)
                .set({
                  attempts: sql`${ConnectorTriggerReceiptTable.attempts} + 1`,
                  next_retry_at: now + reclaimMs,
                  time_updated: now,
                })
                .where(
                  and(
                    eq(ConnectorTriggerReceiptTable.state, "received"),
                    lte(ConnectorTriggerReceiptTable.next_retry_at, now),
                    lt(ConnectorTriggerReceiptTable.attempts, maxAttempts),
                  ),
                )
                .returning()
                .all()
            }),
          )
          .pipe(Effect.orDie),
      completeReceipt: (input) =>
        db
          .transaction((tx) =>
            Effect.gen(function* () {
              const now = Date.now()
              const mirrored = yield* tx
                .update(ConnectorTriggerScheduleTable)
                .set({
                  checkpoint: input.checkpoint,
                  checkpoint_revision: sql`${ConnectorTriggerScheduleTable.checkpoint_revision} + 1`,
                  time_updated: now,
                })
                .where(
                  and(
                    eq(ConnectorTriggerScheduleTable.id, input.scheduleId),
                    eq(ConnectorTriggerScheduleTable.checkpoint_revision, input.expectedRevision),
                  ),
                )
                .returning({ id: ConnectorTriggerScheduleTable.id })
                .all()
              if (mirrored.length === 0) return yield* Effect.fail(new ReceiptSettled())
              const settled = yield* tx
                .update(ConnectorTriggerReceiptTable)
                .set({ state: "processed", engine_result: input.engineResult, checkpoint: input.checkpoint, time_updated: now })
                .where(and(eq(ConnectorTriggerReceiptTable.id, input.id), eq(ConnectorTriggerReceiptTable.state, "received")))
                .returning({ id: ConnectorTriggerReceiptTable.id })
                .all()
              if (settled.length === 0) return yield* Effect.fail(new ReceiptSettled())
              return true
            }),
          )
          .pipe(
            Effect.catchTag("ReceiptSettled", () => Effect.succeed(false)),
            Effect.orDie,
          ),
      recordReceiptFailure: (input) =>
        db
          .update(ConnectorTriggerReceiptTable)
          .set({
            engine_result: input.engineResult,
            next_retry_at: input.nextRetryAt,
            ...(input.failed ? { state: "failed" } : {}),
            time_updated: Date.now(),
          })
          .where(and(eq(ConnectorTriggerReceiptTable.id, input.id), eq(ConnectorTriggerReceiptTable.state, "received")))
          .run()
          .pipe(Effect.orDie),
      listUndeliveredEvents: (scheduleId) =>
        db
          .select()
          .from(ConnectorTriggerEventTable)
          .where(and(eq(ConnectorTriggerEventTable.schedule_id, scheduleId), sql`${ConnectorTriggerEventTable.delivered_at} is null`))
          .orderBy(asc(ConnectorTriggerEventTable.time_created))
          .all()
          .pipe(Effect.orDie),
      markDelivered: (ids) =>
        ids.length === 0
          ? Effect.void
          : db
              .update(ConnectorTriggerEventTable)
              .set({ delivered_at: Date.now(), time_updated: Date.now() })
              .where(inArray(ConnectorTriggerEventTable.id, [...ids]))
              .run()
              .pipe(Effect.orDie),
    })
  }),
)

export const node = makeGlobalNode({ service: Connector.TriggerStore, layer, deps: [Database.node] })
