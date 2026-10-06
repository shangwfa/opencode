export * as SessionToolGate from "./tool-gate.js"

import { Effect } from "effect"
import { and, eq, sql } from "drizzle-orm"
import type { Database } from "../database/database.js"
import { SessionExecutionGateTable as Logical, SandboxExecutionGateTable as Root, SessionTable } from "./sql.js"
import { rootSessionID } from "../sandbox/provider.js"
import { SandboxTable } from "../sandbox/sql.js"

/** A close owns exactly this epoch; a stale request cannot undo another close. */
export interface Closure {
  readonly sessionID: string
  readonly rootID: string
  readonly physical: boolean
  readonly sandboxID: string | null
  readonly epoch: number
}

export class CreationClosedError extends Error {}

/** A no-op UPDATE locks rows on PG and obtains a write transaction on SQLite. */
export function make(db: Database.Interface["db"]) {
  const root = (sessionID: string) =>
    rootSessionID(sessionID, (id) =>
      db
        .select({ parentID: SessionTable.parent_id })
        .from(SessionTable)
        .where(eq(SessionTable.id, id as typeof SessionTable.$inferSelect.id))
        .get()
        .pipe(Effect.orDie),
    )

  const locked = <A, E, R>(
    sessionID: string,
    effect: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0], rootID: string) => Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      const rootID = yield* root(sessionID)
      return yield* db.transaction((tx) =>
        Effect.gen(function* () {
          const now = Date.now()
          yield* tx.insert(Root).values({ root_session_id: rootID, time_updated: now }).onConflictDoNothing().run()
          yield* tx.update(Root).set({ time_updated: now }).where(eq(Root.root_session_id, rootID)).run()
          yield* tx
            .insert(Logical)
            .values({ session_id: sessionID, root_session_id: rootID, time_updated: now })
            .onConflictDoNothing()
            .run()
          yield* tx.update(Logical).set({ time_updated: now }).where(eq(Logical.session_id, sessionID)).run()
          return yield* effect(tx, rootID)
        }),
      )
    }).pipe(Effect.mapError((cause) => (cause instanceof Error ? cause : new Error(String(cause)))))

  return {
    creating: <A, E, R>(
      sessionID: string,
      execute: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Effect.Effect<A, E, R>,
    ) =>
      locked(sessionID, (tx, rootID) =>
        Effect.gen(function* () {
          const exists = yield* tx
            .select({ id: SessionTable.id })
            .from(SessionTable)
            .where(eq(SessionTable.id, sessionID as typeof SessionTable.$inferSelect.id))
            .get()
          const logical = yield* tx.select().from(Logical).where(eq(Logical.session_id, sessionID)).get()
          const physical = yield* tx.select().from(Root).where(eq(Root.root_session_id, rootID)).get()
          if (!exists || logical?.state !== "open" || physical?.state === "closing")
            return yield* Effect.fail(new CreationClosedError("Session sandbox creation is closed"))
          // The same row locks fence close() and the lease mutation. A detached
          // retry cannot pass this check and claim/complete after Session deletion.
          return yield* execute(tx)
        }),
      ),
    admit: <A, E, R>(sessionID: string, sandboxID: string, execute: (epoch: number) => Effect.Effect<A, E, R>) =>
      locked(sessionID, (tx, rootID) =>
        Effect.gen(function* () {
          const exists = yield* tx
            .select({ id: SessionTable.id })
            .from(SessionTable)
            .where(eq(SessionTable.id, sessionID as typeof SessionTable.$inferSelect.id))
            .get()
          const logical = yield* tx.select().from(Logical).where(eq(Logical.session_id, sessionID)).get()
          const physical = yield* tx.select().from(Root).where(eq(Root.root_session_id, rootID)).get()
          if (!exists || logical?.state !== "open" || physical?.state !== "open" || physical.sandbox_id !== sandboxID)
            return yield* Effect.fail(new Error("Session tool admission is closed or Sandbox changed"))
          // Lock this generation through dispatch acknowledgement. Teardown's
          // state transition cannot race between this check and dispatch.
          const current = yield* tx
            .update(SandboxTable)
            .set({ time_updated: sql`${SandboxTable.time_updated}` })
            .where(
              and(
                eq(SandboxTable.session_id, rootID),
                eq(SandboxTable.id, sandboxID),
                eq(SandboxTable.state, "running"),
              ),
            )
            .returning({ id: SandboxTable.id })
            .all()
          if (current.length === 0) return yield* Effect.fail(new Error("Sandbox lifecycle admission is closed"))
          return yield* execute(logical.epoch + physical.epoch)
        }),
      ),
    booted: (sessionID: string, sandboxID: string) =>
      locked(sessionID, (tx, rootID) =>
        Effect.gen(function* () {
          const exists = yield* tx
            .select({ id: SessionTable.id })
            .from(SessionTable)
            .where(eq(SessionTable.id, sessionID as typeof SessionTable.$inferSelect.id))
            .get()
          const logical = yield* tx.select().from(Logical).where(eq(Logical.session_id, sessionID)).get()
          if (!exists || logical?.state !== "open")
            return yield* Effect.fail(new CreationClosedError("Session sandbox creation is closed"))
          const physical = yield* tx.select().from(Root).where(eq(Root.root_session_id, rootID)).get()
          const row = yield* tx.select().from(SandboxTable).where(eq(SandboxTable.session_id, rootID)).get()
          if (!row || row.id !== sandboxID || row.state !== "running")
            return yield* Effect.fail(new Error("Sandbox identity is no longer current"))
          if (physical?.state === "closing" && physical.sandbox_id === sandboxID)
            return yield* Effect.fail(new Error("Sandbox destruction is in progress"))
          if (physical?.state === "closed" && physical.sandbox_id === sandboxID)
            return yield* Effect.fail(new Error("Destroyed Sandbox cannot reopen admission"))
          if (physical?.sandbox_id === sandboxID && physical.state === "open") return
          yield* tx
            .update(Root)
            .set({ state: "open", sandbox_id: sandboxID, epoch: sql`${Root.epoch} + 1` })
            .where(eq(Root.root_session_id, rootID))
            .run()
        }),
      ),
    close: (
      sessionID: string,
      ...[physical, expectedSandboxID]: [physical: false] | [physical: true, expectedSandboxID: string]
    ): Effect.Effect<Closure | null, Error> =>
      locked(sessionID, (tx, rootID) =>
        Effect.gen(function* () {
          if (physical) {
            const row = yield* tx.select().from(SandboxTable).where(eq(SandboxTable.session_id, rootID)).get()
            if (
              !row ||
              row.state === "creating" ||
              row.state === "destroyed" ||
              (expectedSandboxID && row.id !== expectedSandboxID)
            )
              return null
            const closed = yield* tx
              .update(Root)
              .set({ state: "closing", sandbox_id: row.id, epoch: sql`${Root.epoch} + 1` })
              .where(eq(Root.root_session_id, rootID))
              .returning({ epoch: Root.epoch })
              .all()
            return closed[0] ? { sessionID, rootID, physical, sandboxID: row.id, epoch: closed[0].epoch } : null
          } else {
            const closed = yield* tx
              .update(Logical)
              .set({ state: "closed", epoch: sql`${Logical.epoch} + 1` })
              .where(eq(Logical.session_id, sessionID))
              .returning({ epoch: Logical.epoch })
              .all()
            return closed[0] ? { sessionID, rootID, physical, sandboxID: null, epoch: closed[0].epoch } : null
          }
        }),
      ),
    destroyed: (sessionID: string, closure: Closure) =>
      locked(sessionID, (tx, rootID) => {
        if (!closure.physical || closure.sessionID !== sessionID || closure.rootID !== rootID || !closure.sandboxID)
          return Effect.succeed(false)
        return tx
          .update(Root)
          .set({ state: "closed" })
          .where(
            and(
              eq(Root.root_session_id, rootID),
              eq(Root.sandbox_id, closure.sandboxID),
              eq(Root.epoch, closure.epoch),
              eq(Root.state, "closing"),
            ),
          )
          .returning({ id: Root.root_session_id })
          .all()
          .pipe(Effect.map((rows) => rows.length > 0))
      }),
    retained: (sessionID: string, closure: Closure) =>
      locked(sessionID, (tx, rootID) =>
        Effect.gen(function* () {
          if (!closure.physical || closure.sessionID !== sessionID || closure.rootID !== rootID || !closure.sandboxID)
            return false
          const row = yield* tx.select().from(SandboxTable).where(eq(SandboxTable.session_id, rootID)).get()
          if (!row || row.id !== closure.sandboxID || row.state !== "running") return false
          const opened = yield* tx
            .update(Root)
            .set({ state: "open", epoch: sql`${Root.epoch} + 1` })
            .where(
              and(
                eq(Root.root_session_id, rootID),
                eq(Root.sandbox_id, closure.sandboxID),
                eq(Root.epoch, closure.epoch),
                eq(Root.state, "closing"),
              ),
            )
            .returning({ id: Root.root_session_id })
            .all()
          return opened.length > 0
        }),
      ),
    reopen: (sessionID: string, closure: Closure) =>
      locked(sessionID, (tx, rootID) =>
        Effect.gen(function* () {
          if (closure.physical || closure.sessionID !== sessionID || closure.rootID !== rootID) return false
          const session = yield* tx
            .select({ id: SessionTable.id })
            .from(SessionTable)
            .where(eq(SessionTable.id, sessionID as typeof SessionTable.$inferSelect.id))
            .get()
          if (!session) return false
          const opened = yield* tx
            .update(Logical)
            .set({ state: "open", epoch: sql`${Logical.epoch} + 1` })
            .where(
              and(eq(Logical.session_id, sessionID), eq(Logical.epoch, closure.epoch), eq(Logical.state, "closed")),
            )
            .returning({ id: Logical.session_id })
            .all()
          return opened.length > 0
        }),
      ),
  }
}
