/**
 * PG-mode tests for the user-scoped auth store (the SaaS path).
 *
 * Requires OPENCODE_DATABASE_URL pointing at a PG instance. Auto-skips
 * otherwise. Uses unique `pgtest-` provider keys and cleans up only its own
 * rows — never resets shared tables.
 *
 * Run with:
 *   OPENCODE_DATABASE_URL=postgresql://local@127.0.0.1:15432/opencode \
 *     bun test test/auth/auth-pg.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { Database, eq, like, or } from "../../src/storage/db"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Auth } from "../../src/auth"
import { AuthTable } from "../../src/auth/auth.pg"

const DB_URL = process.env.OPENCODE_DATABASE_URL
const enabled = !!DB_URL && Database.dialect === "pg"

const P = "pgtest-provider"

const runtime = ManagedRuntime.make(LayerNode.compile(Auth.node) as any)
const db = Database.Client()

async function cleanupRows() {
  await db
    .delete(AuthTable)
    .where(or(eq(AuthTable.provider_id, P), like(AuthTable.provider_id, `%/${P}`)))
    .run()
}

function run<A, E>(effect: Effect.Effect<A, E, Auth.Service>) {
  return runtime.runPromise(effect)
}

describe.skipIf(!enabled)("Auth PG user-scoped store", () => {
  beforeAll(async () => {
    await Database.initialize()
    await cleanupRows()
  })

  afterEach(async () => {
    await cleanupRows()
  })

  afterAll(async () => {
    await runtime.dispose().catch(() => undefined)
    await Database.close().catch(() => undefined)
  })

  test("stores personal rows under the namespaced provider_id with user_id set", async () => {
    await run(Auth.Service.use((auth) => auth.set(P, { type: "api", key: "user-1-key" }, "user-1")))
    const rows = await db.select().from(AuthTable).where(eq(AuthTable.provider_id, `user-1/${P}`)).all()
    expect(rows).toHaveLength(1)
    expect(rows[0].user_id).toBe("user-1")
    expect(rows[0].provider_id).toBe(`user-1/${P}`)
  })

  test("personal and public rows coexist; reads prefer the public row", async () => {
    await run(
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set(P, { type: "api", key: "public-key" })
        yield* auth.set(P, { type: "api", key: "user-1-key" }, "user-1")
      }),
    )
    const rows = await db.select().from(AuthTable).where(eq(AuthTable.provider_id, P)).all()
    expect(rows).toHaveLength(1)
    expect(rows[0].user_id).toBe("")

    await run(
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        expect(yield* auth.get(P)).toEqual({ type: "api", key: "public-key" })
        expect(yield* auth.get(P, "user-1")).toEqual({ type: "api", key: "public-key" })
        expect(yield* auth.get(P, "user-2")).toEqual({ type: "api", key: "public-key" })
      }),
    )
  })

  test("falls back to the personal row once the public row is removed", async () => {
    await run(
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set(P, { type: "api", key: "public-key" })
        yield* auth.set(P, { type: "api", key: "user-1-key" }, "user-1")
        yield* auth.remove(P)

        expect(yield* auth.get(P)).toBeUndefined()
        expect(yield* auth.get(P, "user-1")).toEqual({ type: "api", key: "user-1-key" })
        expect(yield* auth.get(P, "user-2")).toBeUndefined()
      }),
    )
  })

  test("anonymous reads never expose personal rows", async () => {
    await run(Auth.Service.use((auth) => auth.set(P, { type: "api", key: "user-1-key" }, "user-1")))
    await run(
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        const anonymous = yield* auth.all()
        expect(anonymous[P]).toBeUndefined()
        const userView = yield* auth.all("user-1")
        expect(userView[P]).toEqual({ type: "api", key: "user-1-key" })
      }),
    )
  })

  test("personal remove only deletes the owner's row", async () => {
    await run(
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set(P, { type: "api", key: "user-1-key" }, "user-1")
        yield* auth.set(P, { type: "api", key: "user-2-key" }, "user-2")
        yield* auth.remove(P, "user-1")

        expect(yield* auth.get(P, "user-1")).toBeUndefined()
        expect(yield* auth.get(P, "user-2")).toEqual({ type: "api", key: "user-2-key" })
      }),
    )
  })

  test("blank user ids write to the public row", async () => {
    await run(Auth.Service.use((auth) => auth.set(P, { type: "api", key: "via-blank" }, "   ")))
    const rows = (await db.select().from(AuthTable).where(eq(AuthTable.provider_id, P)).all()) as {
      user_id: string
    }[]
    expect(rows.map((row) => row.user_id)).toEqual([""])
    await run(
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        expect(yield* auth.get(P)).toEqual({ type: "api", key: "via-blank" })
      }),
    )
  })

  test("oversized user ids are truncated consistently for write and read", async () => {
    const long = "a".repeat(200)
    await run(Auth.Service.use((auth) => auth.set(P, { type: "api", key: "long-key" }, long)))
    await run(
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        expect(yield* auth.get(P, long)).toEqual({ type: "api", key: "long-key" })
        expect(yield* auth.get(P, "a".repeat(128))).toEqual({ type: "api", key: "long-key" })
      }),
    )
  })
})
