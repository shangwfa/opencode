import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "../../src/database/drizzle.js"
import { Database as DB } from "../../src/database/database.js"
import { Global } from "@opencode/util/global"
import { insert } from "../../src/exec-log/index.js"
import { ExecLogTable } from "../../src/exec-log/sql.js"
import { eq } from "drizzle-orm"

// In-memory SQLite database with the exec_log table (no FK enforcement).
const makeDb = EffectDrizzleSqlite.makeWithDefaults()

const testLayer = Layer.effect(
  DB.Service,
  Effect.gen(function* () {
    const db = yield* makeDb
    yield* db.run(`
      CREATE TABLE exec_log (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        command TEXT NOT NULL,
        working_directory TEXT,
        status TEXT NOT NULL,
        exit_code INTEGER,
        stdout TEXT,
        stderr TEXT,
        error TEXT,
        rule TEXT,
        trace_id TEXT,
        source TEXT NOT NULL,
        time_started INTEGER NOT NULL,
        time_finished INTEGER,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL
      )
    `)
    return { db }
  }).pipe(Effect.orDie),
).pipe(
  Layer.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })),
  Layer.provide(Global.layerWith({})),
)

const run = <A, E>(effect: Effect.Effect<A, E, DB.Service>) =>
  Effect.runPromise(effect.pipe(Effect.provide(testLayer), Effect.scoped, Effect.orDie))

const newRow = (id: string) => ({
  id,
  session_id: "ses_test_session_id" as any,
  command: "echo hello",
  status: "completed" as const,
  source: "bash" as const,
  time_started: Date.now(),
  time_created: Date.now(),
  time_updated: Date.now(),
})

describe("exec-log trace_id", () => {
  test("insert stores row with null trace_id when no active span", async () => {
    const id = "exec-trace-test-1"
    await run(
      Effect.gen(function* () {
        yield* insert(newRow(id))
        const { db } = yield* DB.Service
        const row = yield* db.select().from(ExecLogTable).where(eq(ExecLogTable.id, id)).get()
        expect(row).toBeDefined()
        expect(row!.trace_id).toBeNull()
      }),
    )
  })

  test("insert stores explicit trace_id when provided", async () => {
    const id = "exec-trace-test-2"
    const traceId = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"
    await run(
      Effect.gen(function* () {
        yield* insert({ ...newRow(id), trace_id: traceId })
        const { db } = yield* DB.Service
        const row = yield* db.select().from(ExecLogTable).where(eq(ExecLogTable.id, id)).get()
        expect(row).toBeDefined()
        expect(row!.trace_id).toBe(traceId)
      }),
    )
  })

  test("insert succeeds without database (graceful no-op)", async () => {
    // No layer provided — Effect.serviceOption returns None.
    await Effect.runPromise(insert(newRow("exec-trace-test-3")))
  })
})