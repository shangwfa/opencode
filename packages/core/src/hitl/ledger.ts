export * as HitlLedger from "./ledger.js"

import { and, eq, inArray } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database.js"
import { SessionSchema } from "../session/schema.js"
import { HitlRequestTable } from "./sql.js"

export type Kind = "form" | "permission"
export type Decision = "pending" | "answered" | "cancelled" | "approved" | "rejected"

export interface Row {
  readonly id: string
  readonly kind: Kind
  readonly sessionID: SessionSchema.ID
  readonly payload: unknown
  readonly decision: Decision
  readonly result: unknown
}

export type DecideOutcome = "updated" | "settled" | "missing"

export interface RegisterInput {
  readonly id: string
  readonly kind: Kind
  readonly sessionID: SessionSchema.ID
  readonly payload: unknown
}

export interface Interface {
  /** Idempotent registration: replays after recovery must not overwrite a settled row. */
  readonly register: (input: RegisterInput) => Effect.Effect<void>
  /** Conditional settle: only a pending row accepts the decision (CAS). */
  readonly decide: (id: string, decision: Exclude<Decision, "pending">, result?: unknown) => Effect.Effect<DecideOutcome>
  readonly get: (id: string) => Effect.Effect<Row | undefined>
  readonly pending: (sessionID?: SessionSchema.ID) => Effect.Effect<ReadonlyArray<Row>>
  /** Current rows for a set of ids, for owner-side polling. */
  readonly states: (ids: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<Row>>
}

const toRow = (row: typeof HitlRequestTable.$inferSelect): Row => ({
  id: row.id,
  kind: row.kind,
  sessionID: row.session_id,
  payload: row.payload,
  decision: row.decision,
  result: row.result ?? undefined,
})

export const make = (db: Database.Interface["db"]): Interface => {
  const register = Effect.fn("HitlLedger.register")(function* (input: RegisterInput) {
    yield* db
      .insert(HitlRequestTable)
      .values({
        id: input.id,
        kind: input.kind,
        session_id: input.sessionID,
        payload: input.payload,
        decision: "pending",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

  const decide = Effect.fn("HitlLedger.decide")(function* (
    id: string,
    decision: Exclude<Decision, "pending">,
    result?: unknown,
  ) {
    const existing = yield* db
      .select({ id: HitlRequestTable.id })
      .from(HitlRequestTable)
      .where(eq(HitlRequestTable.id, id))
      .get()
      .pipe(Effect.orDie)
    if (!existing) return "missing" as const
    const rows = yield* db
      .update(HitlRequestTable)
      .set({ decision, result: result === undefined ? null : result })
      .where(and(eq(HitlRequestTable.id, id), eq(HitlRequestTable.decision, "pending")))
      .returning({ id: HitlRequestTable.id })
      .all()
      .pipe(Effect.orDie)
    return rows.length > 0 ? ("updated" as const) : ("settled" as const)
  })

  const get = Effect.fn("HitlLedger.get")(function* (id: string) {
    const row = yield* db.select().from(HitlRequestTable).where(eq(HitlRequestTable.id, id)).get().pipe(Effect.orDie)
    return row ? toRow(row) : undefined
  })

  const pending = Effect.fn("HitlLedger.pending")(function* (sessionID?: SessionSchema.ID) {
    const rows = yield* db
      .select()
      .from(HitlRequestTable)
      .where(
        sessionID
          ? and(eq(HitlRequestTable.session_id, sessionID), eq(HitlRequestTable.decision, "pending"))
          : eq(HitlRequestTable.decision, "pending"),
      )
      .all()
      .pipe(Effect.orDie)
    return rows.map(toRow)
  })

  const states = Effect.fn("HitlLedger.states")(function* (ids: ReadonlyArray<string>) {
    if (ids.length === 0) return []
    const rows = yield* db
      .select()
      .from(HitlRequestTable)
      .where(inArray(HitlRequestTable.id, [...ids]))
      .all()
      .pipe(Effect.orDie)
    return rows.map(toRow)
  })

  return { register, decide, get, pending, states }
}
