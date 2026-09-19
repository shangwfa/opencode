import { describe, expect } from "bun:test"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Database } from "@opencode/core/database/database"
import { ProjectTable } from "@opencode/core/project/sql"
import { WorkspaceTable } from "@opencode/core/workspace/sql"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Effect, Exit } from "effect"
import { sql } from "drizzle-orm"
import { testEffect } from "./lib/effect"

// Real PG integration against a dedicated test database (never the v1 fleet's
// `opencode` database). Runs only when OPENCODE_PG_TEST_URL points somewhere
// reachable; migrations apply into that database.
//
// The bridge surface is declared explicitly below: the compiled core d.ts and
// this test file resolve drizzle/schema types through different contexts, so
// nominal table types do not unify here — the runtime contract (asserted by
// the probes that shaped this file) is what matters.
interface BridgeDb {
  select(): { from(table: unknown): { where(cond: unknown): { get(): Effect.Effect<Row | undefined>; all(): Effect.Effect<Array<Row>> } } }
  insert(table: unknown): {
    values(value: Record<string, unknown>): {
      onConflictDoNothing(): { run(): Effect.Effect<void> }
      run(): Effect.Effect<void>
    }
  }
  update(table: unknown): { set(value: Record<string, unknown>): { where(cond: unknown): { run(): Effect.Effect<void> } } }
  delete(table: unknown): { where(cond: unknown): { run(): Effect.Effect<void> } }
  transaction<T>(fn: (tx: BridgeDb) => Effect.Effect<T, unknown>): Effect.Effect<T, unknown>
}

type Row = { readonly provider?: string; readonly binding?: unknown }

const url = process.env["OPENCODE_PG_TEST_URL"]
const pgAvailable = url !== undefined && url.length > 0
// The PG branch inside Database.layer reads OPENCODE_DATABASE_URL; point it at
// the dedicated test database unless the caller already chose one.
if (pgAvailable && process.env["OPENCODE_DATABASE_URL"] === undefined) {
  process.env["OPENCODE_DATABASE_URL"] = url
}

describe.skipIf(!pgAvailable)("database pg bridge", () => {
  const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.configured()]), []))

  const bridge = Effect.gen(function* () {
    const { db } = yield* Database.Service
    return db as unknown as BridgeDb
  })

  it.effect(
    "applies migrations and round-trips a workspace row through the bridge",
    () =>
      Effect.gen(function* () {
        const db = yield* bridge
        const id = "wrk_pgtest_0001"

        yield* db.delete(WorkspaceTable).where(sql`id = ${id}`).run()
        yield* db
          .insert(WorkspaceTable)
          .values({ id, provider: "pgtest", binding: null, created_at: 111, last_used_at: 111 })
          .onConflictDoNothing()
          .run()

        const row = yield* db.select().from(WorkspaceTable).where(sql`id = ${id}`).get()
        expect(row?.provider).toBe("pgtest")

        // json-mode column through the bridge: object in, object out.
        yield* db
          .update(WorkspaceTable)
          .set({ binding: { containerName: "x", generation: 3 } })
          .where(sql`id = ${id}`)
          .run()
        const updated = yield* db.select().from(WorkspaceTable).where(sql`id = ${id}`).get()
        expect((updated?.binding as { containerName: string }).containerName).toBe("x")

        // upsert conflict path (create's idempotency shape)
        yield* db
          .insert(WorkspaceTable)
          .values({ id, provider: "pgtest", binding: null, created_at: 222, last_used_at: 222 })
          .onConflictDoNothing()
          .run()
        const count = yield* db.select().from(WorkspaceTable).where(sql`id = ${id}`).all()
        expect(count).toHaveLength(1)

        yield* db.delete(WorkspaceTable).where(sql`id = ${id}`).run()
        const gone = yield* db.select().from(WorkspaceTable).where(sql`id = ${id}`).get()
        expect(gone).toBeUndefined()
      }),
    60_000,
  )

  it.effect(
    "transactions roll back on failure and survive interruption semantics",
    () =>
      Effect.gen(function* () {
        const db = yield* bridge
        const id = "wrk_pgtest_tx01"

        yield* db.delete(WorkspaceTable).where(sql`id = ${id}`).run()
        const result = yield* Effect.exit(
          db.transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .insert(WorkspaceTable)
                .values({ id, provider: "pgtest", binding: null, created_at: 1, last_used_at: 1 })
                .run()
              // Fail inside the transaction: nothing must be persisted.
              return yield* Effect.fail(new Error("rollback probe"))
            }),
          ),
        )
        expect(Exit.isFailure(result)).toBe(true)

        const row = yield* db.select().from(WorkspaceTable).where(sql`id = ${id}`).get()
        expect(row).toBeUndefined()

        // Commit path persists.
        yield* db.transaction((tx) =>
          tx
            .insert(WorkspaceTable)
            .values({ id, provider: "pgtest", binding: null, created_at: 2, last_used_at: 2 })
            .run(),
        )
        const committed = yield* db.select().from(WorkspaceTable).where(sql`id = ${id}`).get()
        expect(committed?.provider).toBe("pgtest")
        yield* db.delete(WorkspaceTable).where(sql`id = ${id}`).run()
      }),
    60_000,
  )

  it.effect(
    "stores millisecond timestamps through bigint columns and reads them back as numbers",
    () =>
      Effect.gen(function* () {
        // Regression: PG `integer` is 32-bit and overflows on Date.now()-scale
        // epochs; the schema keeps sqlite's 64-bit semantics via bigint, and the
        // client type override parses int8 back to numbers.
        const db = yield* bridge
        const id = "prj_pgtest_ts01"
        const now = Date.now()

        yield* db.delete(ProjectTable).where(sql`id = ${id}`).run()
        yield* db
          .insert(ProjectTable)
          .values({ id, worktree: "/tmp/pgtest", sandboxes: [], time_created: now, time_updated: now })
          .run()

        const row = (yield* db.select().from(ProjectTable).where(sql`id = ${id}`).get()) as
          | Record<string, unknown>
          | undefined
        expect(row).toBeDefined()
        expect(typeof row?.time_created).toBe("number")
        expect(Number(row?.time_created)).toBe(now)
        yield* db.delete(ProjectTable).where(sql`id = ${id}`).run()
      }),
    60_000,
  )
})
