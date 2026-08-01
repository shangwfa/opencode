/**
 * Bridge between SaaS PG drizzle and core's Effect-based Database.Service.
 *
 * Core code: `yield* db.select().from(T).where(...).get()` — `.get()` returns Effect.
 * PG drizzle: `.get()` returns Promise (via our shim in db.pg.ts).
 *
 * Strategy: Proxy every object in the query chain. Any property access that
 * returns a function is wrapped so its return value is also proxied. Terminal
 * methods `.get()`, `.run()`, `.all()` are intercepted to return Effect.
 */
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { Database as SaasDb } from "./db"

const TERMINALS = new Set(["get", "run", "all"])

function wrap(target: any): any {
  if (target == null || typeof target !== "object") return target
  return new Proxy(target, {
    get(obj, prop) {
      if (typeof prop === "symbol") return obj[prop]

      // Terminal methods → return Effect wrapping the Promise
      if (TERMINALS.has(prop as string)) {
        return (...args: any[]) => {
          const val = obj[prop]
          if (typeof val !== "function") return Effect.succeed(undefined)
          const result = val.apply(obj, args)
          if (result && typeof result.then === "function") {
            return Effect.promise(() => result)
          }
          return Effect.succeed(result)
        }
      }

      // pipe — Effect method, should not exist on PG drizzle objects.
      // If core code does `.run().pipe(Effect.orDie)`, `.run()` already
      // returns an Effect (from our interception above), so `.pipe` is
      // available on the Effect itself — no interception needed here.

      const val = obj[prop]
      if (typeof val === "function") {
        return (...args: any[]) => {
          const result = val.apply(obj, args)
          if (result != null && typeof result === "object" && !result[Symbol.iterator] && !(result instanceof Promise)) {
            return wrap(result)
          }
          return result
        }
      }
      return val
    },
  })
}

function wrapTransaction(pgDb: any) {
  return (fn: (tx: any) => any) => {
    // Run the postgres.js transaction to completion regardless of outer
    // interruption. If we let the effect be interrupted mid-transaction, the
    // `client.begin` connection is abandoned while still open — every
    // concurrent durable commit leaks one `idle in transaction` connection,
    // eventually exhausting the pool and hanging all requests. Interruption
    // is deferred until the transaction has committed or rolled back.
    return Effect.uninterruptible(
      Effect.promise(() =>
        SaasDb.transaction(async (tx: any) => {
          const result = fn(wrap(tx))
          if (Effect.isEffect(result)) return await Effect.runPromise(result as any)
          return result
        }),
      ),
    )
  }
}

function createBridgeDb(): any {
  const pgDb = SaasDb.Client()
  const wrapped = wrap(pgDb)

  // Override transaction to use Effect semantics
  return new Proxy(wrapped, {
    get(obj: any, prop: string | symbol) {
      if (prop === "transaction") return wrapTransaction(pgDb)
      // Raw SQL methods: db.run(sql`...`), db.get(sql`...`), db.all(sql`...`)
      // These are called with drizzle sql tagged templates.
      if (prop === "run" || prop === "get" || prop === "all") {
        return (...args: any[]) => {
          // If called with a drizzle sql template (has .sql/.params), use execute
          const arg = args[0]
          if (arg && typeof arg === "object" && ("sql" in arg || "queryChunks" in arg)) {
            return Effect.promise(async () => {
              const rows = await pgDb.execute(arg)
              if (prop === "get") return Array.isArray(rows) ? rows[0] : rows
              return rows
            })
          }
          // Otherwise delegate to the wrapped proxy (query builder terminal)
          return obj[prop](...args)
        }
      }
      return obj[prop]
    },
  })
}

export const pgDatabaseLayer = Layer.sync(Database.Service, () =>
  Database.Service.of({ db: createBridgeDb() }),
)
