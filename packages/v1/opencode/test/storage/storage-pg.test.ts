import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Git } from "@/git"

// The storage dialect is resolved at module load, so the PG env must be set
// before this module (and its transitive imports) is imported. Run with:
//   OPENCODE_DATABASE_URL=postgresql://local@localhost:15432/opencode bun test test/storage/storage-pg.test.ts
const url = process.env.OPENCODE_DATABASE_URL ?? "postgresql://local@localhost:15432/opencode_test"
process.env.OPENCODE_DATABASE_URL = url

const { Storage, NotFoundError } = await import("../../src/storage/storage")

async function pgReachable() {
  const m = /:\/\/[^@]*@([^:/]+):(\d+)/.exec(url)
  const host = m?.[1] ?? "localhost"
  const port = Number(m?.[2] ?? 5432)
  try {
    const socket = await Bun.connect({
      hostname: host,
      port,
      socket: {
        data() {},
        close() {},
      },
    })
    socket.end()
    return true
  } catch {
    return false
  }
}

const reachable = await pgReachable()

const layer = Layer.mergeAll(LayerNode.compile(LayerNode.group([Storage.node, FSUtil.node, Git.node]))) as Layer.Layer<
  Storage.Interface,
  any,
  any
>

const run = <A, E>(effect: Effect.Effect<A, E, any>) => Effect.runPromise(effect.pipe(Effect.provide(layer)))

// The test database may be pristine or dirty (the app's PG migrations run
// whenever the layer is built with a PG env), so reset the schema first.
// Only point OPENCODE_DATABASE_URL at a disposable test database.
async function ensureTable() {
  const postgres = (await import("postgres")).default
  const client = postgres(url, { max: 1 })
  await client.unsafe(`DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;`)
  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS "storage_data" (
      "key" text PRIMARY KEY,
      "data" jsonb NOT NULL,
      "time_updated" bigint NOT NULL
    )
  `)
  await client.end()
}

if (reachable) {
  await ensureTable()
}

const runId = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const prefix = ["test_storage_pg", runId]
const key = (...parts: string[]) => [...prefix, ...parts]

describe.skipIf(!reachable)("Storage PG branch", () => {
  afterEach(async () => {
    // Best-effort cleanup of everything under the test prefix.
    try {
      await run(
        Effect.gen(function* () {
          const storage = yield* Storage.Service
          const keys = yield* storage.list(prefix)
          for (const k of keys) yield* storage.remove(k)
        }),
      )
    } catch {}
  })

  test("write then read roundtrips nested JSON faithfully", async () => {
    const doc = { b: 1, nested: { arr: [1, "two", { three: true }] }, s: "text" }
    const result = await run(
      Effect.gen(function* () {
        const storage = yield* Storage.Service
        yield* storage.write(key("doc"), doc)
        return yield* storage.read<typeof doc>(key("doc"))
      }),
    )
    expect(result).toEqual(doc)
  })

  test("read of a missing key fails with NotFoundError", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const storage = yield* Storage.Service
        return yield* storage.read(key("missing"))
      }),
    ).then(
      () => "resolved",
      (error: unknown) => error,
    )
    expect(outcome).toBeInstanceOf(NotFoundError)
  })

  test("write overwrites an existing key (upsert)", async () => {
    const result = await run(
      Effect.gen(function* () {
        const storage = yield* Storage.Service
        yield* storage.write(key("over"), { v: 1 })
        yield* storage.write(key("over"), { v: 2 })
        return yield* storage.read<{ v: number }>(key("over"))
      }),
    )
    expect(result).toEqual({ v: 2 })
  })

  test("update applies a functional draft mutation", async () => {
    const result = await run(
      Effect.gen(function* () {
        const storage = yield* Storage.Service
        yield* storage.write(key("upd"), { n: 1 })
        return yield* storage.update<{ n: number }>(key("upd"), (draft) => {
          draft.n += 41
        })
      }),
    )
    expect(result).toEqual({ n: 42 })
  })

  test("remove deletes the entry", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const storage = yield* Storage.Service
        yield* storage.write(key("gone"), { x: true })
        yield* storage.remove(key("gone"))
        return yield* storage.read(key("gone"))
      }),
    ).then(
      () => "resolved",
      (error: unknown) => error,
    )
    expect(outcome).toBeInstanceOf(NotFoundError)
  })

  test("list returns keys under a prefix, sorted, and excludes sibling prefixes", async () => {
    const result = await run(
      Effect.gen(function* () {
        const storage = yield* Storage.Service
        const base = key("list")
        for (const name of ["c", "a", "b"]) {
          yield* storage.write([...base, name], { name })
        }
        // A sibling whose name shares the runId prefix characters must not leak in.
        yield* storage.write(["test_storage_pg", `${runId}zz`, "x"], { sibling: true })
        return yield* storage.list(base)
      }),
    )
    expect(result).toEqual([key("list", "a"), key("list", "b"), key("list", "c")])
  })

  test("list on the run prefix only returns this run's keys", async () => {
    const result = await run(
      Effect.gen(function* () {
        const storage = yield* Storage.Service
        const keys = yield* storage.list(prefix)
        return keys.map((k) => k[1])
      }),
    )
    for (const name of result) {
      expect(name).toBe(runId)
    }
  })
})
