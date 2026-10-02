// session_snapshot.creating 部分唯一索引（跨实例快照创建仲裁）PG 回归。
// 未设 OPENCODE_DATABASE_URL 时静默 skip。
import { expect } from "bun:test"
import { and, eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { SessionSnapshotTable } from "@opencode/core/sandbox/snapshot.sql"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/schema/schema"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node]),
    [Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") }))],
  ),
)
const pgTest = process.env.OPENCODE_DATABASE_URL ? it.effect : it.effect.skip

type Table = typeof SessionSnapshotTable
const asDb = (db: unknown) =>
  db as {
    insert: (t: Table) => {
      values: (v: Record<string, unknown>) => {
        run: () => Effect.Effect<unknown>
        onConflictDoNothing: () => {
          returning: (fields: { id: unknown }) => { all: () => Effect.Effect<Array<{ id: unknown }>> }
        }
      }
    }
    delete: (t: Table) => { where: (c: unknown) => { run: () => Effect.Effect<unknown> } }
    select: () => {
      from: (t: Table) => {
        where: (c: unknown) => { limit: (n: number) => { all: () => Effect.Effect<Array<Record<string, unknown>>> } }
      }
    }
  }

const insertCreating = (db: unknown, id: string, sessionID: string) =>
  asDb(db)
    .insert(SessionSnapshotTable)
    .values({
      id,
      session_id: sessionID,
      scope: "session",
      state: "creating",
      reason: null,
      time_created: Date.now(),
      time_updated: Date.now(),
    })

pgTest("the partial unique index admits one creating row; the loser's insert returns empty", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const sessionID = `snap-uniq-${Date.now()}`
    try {
      // Winner inserts first.
      const winner = yield* insertCreating(db, "uniq-winner-1", sessionID).onConflictDoNothing().returning({ id: SessionSnapshotTable.id }).all()
      expect(winner.length).toBe(1)

      // Loser (same session+scope, state=creating) conflicts and gets no row
      // back — startSnapshot treats this as "roll back and join the winner".
      const loser = yield* insertCreating(db, "uniq-loser-1", sessionID).onConflictDoNothing().returning({ id: SessionSnapshotTable.id }).all()
      expect(loser.length).toBe(0)

      // Terminal rows coexist (a ready row inserts fine), but the winner's
      // creating row still holds the index, so a further creating insert
      // keeps conflicting until it settles.
      yield* asDb(db)
        .insert(SessionSnapshotTable)
        .values({
          id: "uniq-old-ready",
          session_id: sessionID,
          scope: "session",
          state: "ready",
          time_created: Date.now() - 10_000,
          time_updated: Date.now() - 10_000,
        })
        .run()
      const again = yield* insertCreating(db, "uniq-after-terminal", sessionID).onConflictDoNothing().returning({ id: SessionSnapshotTable.id }).all()
      expect(again.length).toBe(0)
    } finally {
      yield* asDb(db)
        .delete(SessionSnapshotTable)
        .where(eq(SessionSnapshotTable.session_id, sessionID))
        .run()
    }
  }),
)

pgTest("after the creating row settles, a new creating row is admitted", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const sessionID = `snap-uniq2-${Date.now()}`
    try {
      yield* insertCreating(db, "uniq2-first", sessionID).run()
      // Simulate the winner settling to ready.
      yield* (db as unknown as {
        update: (t: Table) => {
          set: (v: Record<string, unknown>) => { where: (c: unknown) => { run: () => Effect.Effect<unknown> } }
        }
      })
        .update(SessionSnapshotTable)
        .set({ state: "ready", time_updated: Date.now() })
        .where(and(eq(SessionSnapshotTable.id, "uniq2-first"), eq(SessionSnapshotTable.state, "creating")))
        .run()
      const next = yield* insertCreating(db, "uniq2-second", sessionID).onConflictDoNothing().returning({ id: SessionSnapshotTable.id }).all()
      expect(next.length).toBe(1)
    } finally {
      yield* asDb(db)
        .delete(SessionSnapshotTable)
        .where(eq(SessionSnapshotTable.session_id, sessionID))
        .run()
    }
  }),
)
