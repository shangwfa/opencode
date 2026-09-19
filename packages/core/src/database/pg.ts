export * as DatabasePg from "./pg.js"

import { Database } from "./database.js"
import { Effect, Layer } from "effect"
import { createHash } from "node:crypto"
import postgres from "postgres"
import { drizzle } from "drizzle-orm/postgres-js"
import { sql } from "drizzle-orm"
import { WorkspaceTable } from "../workspace/sql.js"

/**
 * SaaS PG mode for the v2 core, ported from the v1 fleet's battle-tested
 * `db-core-bridge` approach: business code keeps importing the sqlite table
 * objects, while a PG drizzle instance (postgres.js driver) is swapped in at
 * the Database.Service layer through a recursive proxy that converts the PG
 * driver's Promise API into the Effect terminals core code expects
 * (`.get()/.run()/.all()` returning Effect), with a per-statement timeout and
 * interruption-deferred transactions (v1 lessons, see docs/saas-architecture).
 *
 * PG schema lives in `packages/core/migration-pg/<timestamp>_<name>/migration.sql`
 * (`--> statement-breakpoint` separated, hash-deduplicated on apply); the core
 * sqlite migrations never run in PG mode.
 */

// Business code constructs and pipes Effect values with its own module
// instance; values built here must come from that same instance or the
// returned objects lack the consumer's prototype methods (v2 lesson). The
// layer entrypoint swaps this to the caller's Effect before any construction.
let E: typeof Effect = Effect

const TERMINALS = new Set(["get", "run", "all"])

const withQueryTimeout = <A, Err, R>(
  effect: Effect.Effect<A, Err, R>,
  timeoutMs: number = Number(process.env.OPENCODE_PG_STATEMENT_TIMEOUT_MS ?? 30000),
): Effect.Effect<A, Err | Error, R> =>
  E.timeoutOrElse(effect, {
    duration: `${timeoutMs} millis`,
    orElse: () => E.fail(new Error(`PG query timed out after ${timeoutMs}ms`)),
  })

/** postgres.js lacks socket-level timeouts; a half-open connection hangs forever. */
function wrap(target: any): any {
  if (target == null || typeof target !== "object") return target
  return new Proxy(target, {
    get(obj, prop) {
      if (typeof prop === "symbol") return obj[prop]
      if (TERMINALS.has(prop as string)) {
        return (...args: ReadonlyArray<unknown>) => {
          const val = obj[prop]
          // A missing shim means installShims never reached this prototype;
          // failing loudly beats a silent no-op that drops writes.
          if (typeof val !== "function") {
            return E.fail(new Error(`PG bridge: ${String(prop)} is not available on ${obj?.constructor?.name ?? "query"}`))
          }
          const result = val.apply(obj, args as [])
          if (result !== null && typeof result === "object" && typeof result.then === "function") {
            return withQueryTimeout(E.promise(() => result as Promise<unknown>))
          }
          return E.succeed(result)
        }
      }
      const val = obj[prop]
      if (typeof val === "function") {
        return (...args: ReadonlyArray<unknown>) => {
          const result = val.apply(obj, args as [])
          // Effect values (v2's Effect-based drizzle terminals surfaced through
          // nested calls) must pass through untouched: proxying one breaks the
          // internal state machine.
          if (E.isEffect(result)) return result
          if (result !== null && typeof result === "object" && !result[Symbol.iterator] && !(result instanceof Promise)) {
            return wrap(result)
          }
          return result
        }
      }
      return val
    },
  })
}

/**
 * Transactions run to completion regardless of outer interruption: abandoning
 * a postgres.js transaction mid-flight leaks an `idle in transaction`
 * connection until the pool is exhausted (v1 lesson).
 */
function wrapTransaction(pgDb: any) {
  return (fn: (tx: any) => any) =>
    E.uninterruptible(
      E.promise(() =>
        pgDb.transaction(async (tx: any) => {
          const result = fn(wrap(tx))
          if (E.isEffect(result)) return await E.runPromise(result as Effect.Effect<unknown, never, never>)
          return result
        }),
      ),
    )
}

function createBridgeDb(pgDb: any) {
  const wrapped = wrap(pgDb)
  return new Proxy(wrapped, {
    get(obj: any, prop: string | symbol) {
      if (prop === "transaction") return wrapTransaction(pgDb)
      // Raw SQL: db.run(sql`...`) / db.get(sql`...`) / db.all(sql`...`)
      if (prop === "run" || prop === "get" || prop === "all") {
        return (...args: ReadonlyArray<unknown>) => {
          const arg = args[0]
          if (arg !== null && typeof arg === "object" && ("sql" in arg || "queryChunks" in arg)) {
            return withQueryTimeout(
              E.promise(async () => {
                const rows = await pgDb.execute(arg)
                if (prop === "get") return Array.isArray(rows) ? rows[0] : rows
                return rows
              }),
            )
          }
          return obj[prop](...args as [])
        }
      }
      return obj[prop]
    },
  })
}

interface MigrationEntry {
  readonly sql: string
  readonly timestamp: number
}

/** Loads `migration-pg/<dir>/migration.sql` entries in directory order. */
async function loadMigrations(root: string): Promise<Array<MigrationEntry>> {
  const { readdir, readFile } = await import("node:fs/promises")
  const entries: Array<MigrationEntry> = []
  for (const dir of (await readdir(root)).sort()) {
    const file = `${root}/${dir}/migration.sql`
    const text = await readFile(file, "utf8").catch(() => undefined)
    if (text === undefined) continue
    entries.push({ sql: text, timestamp: Number(dir.split("_")[0]) || 0 })
  }
  return entries
}

const MIGRATION_LOCK_ID = 20191001

async function migratePg(db: any, entries: ReadonlyArray<MigrationEntry>) {
  await db.execute(sql`SELECT pg_advisory_lock(${MIGRATION_LOCK_ID})`)
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS __drizzle_migrations (
        id SERIAL PRIMARY KEY,
        hash TEXT NOT NULL UNIQUE,
        created_at BIGINT
      )
    `)
    for (const entry of entries) {
      const hash = createHash("sha256").update(entry.sql).digest("hex")
      const applied = await db.execute(sql`SELECT 1 FROM __drizzle_migrations WHERE hash = ${hash}`)
      if (applied.length > 0) continue
      const statements = entry.sql.split("--> statement-breakpoint").filter((statement) => statement.trim().length > 0)
      // postgres.js disallows raw BEGIN on pooled connections; drizzle's
      // transaction API issues its own.
      await db.transaction(async (tx: any) => {
        for (const statement of statements) await tx.execute(sql.raw(statement))
        await tx.execute(sql`INSERT INTO __drizzle_migrations (hash, created_at) VALUES (${hash}, ${entry.timestamp})`)
      })
    }
  } finally {
    await db.execute(sql`SELECT pg_advisory_unlock(${MIGRATION_LOCK_ID})`).catch(() => undefined)
  }
}

/**
 * Installs `.run/.get/.all` Promise shims onto PG query prototypes so that
 * sqlite-style chained calls compile against the PG driver (v1 `db.pg.ts`).
 */
function installShims(db: any, probeTable: any) {
  const shim = (proto: any) => {
    if (proto === null || proto === Object.prototype) return
    if (typeof proto.run !== "function") proto.run = function () {
      return Promise.resolve(this).then(() => undefined)
    }
    if (typeof proto.all !== "function") proto.all = function () {
      return Promise.resolve(this)
    }
    if (typeof proto.get !== "function") proto.get = function () {
      return Promise.resolve(this).then((rows: unknown) => (Array.isArray(rows) ? rows[0] : rows))
    }
  }
  const walk = (obj: any) => {
    let proto = Object.getPrototypeOf(obj)
    while (proto !== null && proto !== Object.prototype) {
      shim(proto)
      proto = Object.getPrototypeOf(proto)
    }
  }
  try {
    walk(db.select().from(probeTable))
    walk(db.delete(probeTable))
    // insert/update builders carry their own prototypes; probe them so their
    // `.run/.get/.all` shims exist (a missing shim makes the bridge report a
    // silent success because terminals degrade to Effect.succeed(undefined)).
    const insert = db.insert(probeTable).values({})
    walk(insert)
    try {
      walk(insert.onConflictDoNothing())
    } catch {}
    try {
      walk(insert.onConflictDoUpdate({ target: (probeTable as any).id, set: {} }))
    } catch {}
    walk(db.update(probeTable).set({ provider: "shim" }))
  } catch {
    // probe failure is non-fatal; missing prototypes surface on first use
  }
}

const pendingMigrations = new Map<string, Array<MigrationEntry>>()

/**
 * The PG database layer. `url` defaults to `OPENCODE_DATABASE_URL`; the
 * caller is responsible for wiring this layer in place of the sqlite one
 * (see `Database.layer`'s PG branch).
 */
export const layer = (url?: string, hostEffect?: typeof Effect) => {
  E = hostEffect ?? Effect
  return Layer.effect(
    Database.Service,
    E.gen(function* () {
      const target = url ?? process.env["OPENCODE_DATABASE_URL"] ?? ""
      if (target.length === 0) {
        return yield* E.die("DatabasePg.layer requires OPENCODE_DATABASE_URL or an explicit url")
      }
      // bigint columns carry millisecond epochs / 64-bit counters; serialize to
      // text and parse back to numbers so bridged rows match the sqlite number
      // shape (v1 OID override).
      const client = postgres(target, {
        max: 10,
        idle_timeout: 30,
        max_lifetime: 60 * 20,
        types: {
          bigint: {
            to: 20,
            from: [20],
            serialize: (x: number | bigint | string) => x.toString(),
            parse: (x: string) => Number(x),
          },
        },
      })
      const pgDb = drizzle({ client })
      installShims(pgDb, WorkspaceTable)
      yield* E.promise(() => Promise.resolve(client`SELECT 1`))
      let migrations = pendingMigrations.get(target)
      if (migrations === undefined) {
        const { fileURLToPath } = yield* E.promise(() => import("node:url"))
        migrations = yield* E.promise(() =>
          loadMigrations(fileURLToPath(new URL("../../migration-pg", import.meta.url))),
        )
        pendingMigrations.set(target, migrations)
      }
      if (migrations.length > 0) {
        yield* E.promise(() => migratePg(pgDb, migrations!))
      }
      yield* E.addFinalizer(() => E.promise(() => client.end().catch(() => undefined)))
      return Database.Service.of({ db: createBridgeDb(pgDb) } as unknown as Database.Interface)
    }).pipe(E.orDie),
  )
}
