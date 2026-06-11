/**
 * Bridge between SaaS PG drizzle instance and core's Effect-based Database.Service.
 *
 * Core code uses `yield* db.select().from(Table).where(...).get()` where `.get()`
 * returns an Effect. Our PG drizzle returns Promises. This bridge wraps the PG
 * drizzle instance with a Proxy that intercepts query-terminal methods
 * (`.get()`, `.run()`, `.all()`) and returns Effects instead of Promises.
 */
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { Database as SaasDb } from "./db"

function wrapQueryBuilder(target: any): any {
  if (target == null || typeof target !== "object") return target
  return new Proxy(target, {
    get(obj, prop) {
      const val = obj[prop]
      // Terminal methods that core expects to return Effect
      if (prop === "get") {
        return (...args: any[]) => {
          const result = typeof val === "function" ? val.apply(obj, args) : undefined
          // PG drizzle .get() shim returns Promise; wrap in Effect
          if (result && typeof result.then === "function") {
            return Effect.promise(() => result)
          }
          return Effect.succeed(result)
        }
      }
      if (prop === "run") {
        return (...args: any[]) => {
          const result = typeof val === "function" ? val.apply(obj, args) : undefined
          if (result && typeof result.then === "function") {
            return Effect.promise(() => result)
          }
          return Effect.succeed(result)
        }
      }
      if (prop === "all") {
        return (...args: any[]) => {
          const result = typeof val === "function" ? val.apply(obj, args) : undefined
          if (result && typeof result.then === "function") {
            return Effect.promise(() => result)
          }
          return Effect.succeed(result)
        }
      }
      // For chaining methods (where, from, set, values, etc.), wrap the result too
      if (typeof val === "function") {
        return (...args: any[]) => {
          const result = val.apply(obj, args)
          // If result is a query builder (has .where/.get/.run), wrap it
          if (result && typeof result === "object" && (result.where || result.get || result.run || result.from)) {
            return wrapQueryBuilder(result)
          }
          return result
        }
      }
      return val
    },
  })
}

function createBridgeDb(): any {
  const pgDb = SaasDb.Client()

  return new Proxy(pgDb, {
    get(obj: any, prop: string) {
      // Raw SQL methods used by core migration/credential code
      if (prop === "run") {
        return (query: any) => Effect.promise(() => (obj as any).execute(query))
      }
      if (prop === "get") {
        return (query: any) =>
          Effect.promise(async () => {
            const rows = await (obj as any).execute(query)
            return Array.isArray(rows) ? rows[0] : rows
          })
      }
      if (prop === "all") {
        return (query: any) => Effect.promise(() => (obj as any).execute(query))
      }
      if (prop === "transaction") {
        return (fn: (tx: any) => any) =>
          Effect.promise(async () => {
            return SaasDb.transaction(async (tx: any) => {
              const wrappedTx = createBridgeTx(tx)
              const effect = fn(wrappedTx)
              // If the callback returns an Effect, run it
              if (effect && typeof effect === "object" && Effect.EffectTypeId in effect) {
                return Effect.runPromise(effect)
              }
              return effect
            })
          })
      }
      // drizzle query methods: select, insert, update, delete
      const val = obj[prop]
      if (typeof val === "function") {
        return (...args: any[]) => {
          const result = val.apply(obj, args)
          if (result && typeof result === "object" && (result.where || result.from || result.get || result.run)) {
            return wrapQueryBuilder(result)
          }
          return result
        }
      }
      return val
    },
  })
}

function createBridgeTx(tx: any): any {
  return new Proxy(tx, {
    get(obj: any, prop: string) {
      if (prop === "run") {
        return (query: any) => Effect.promise(() => obj.execute ? obj.execute(query) : Promise.resolve())
      }
      if (prop === "get") {
        return (query: any) =>
          Effect.promise(async () => {
            const rows = obj.execute ? await obj.execute(query) : []
            return Array.isArray(rows) ? rows[0] : rows
          })
      }
      if (prop === "all") {
        return (query: any) => Effect.promise(() => obj.execute ? obj.execute(query) : Promise.resolve([]))
      }
      const val = obj[prop]
      if (typeof val === "function") {
        return (...args: any[]) => {
          const result = val.apply(obj, args)
          if (result && typeof result === "object" && (result.where || result.from || result.get || result.run)) {
            return wrapQueryBuilder(result)
          }
          return result
        }
      }
      return val
    },
  })
}

/**
 * Creates a core Database.Service layer backed by the SaaS PG drizzle instance.
 * The bridge wraps query builders so terminal methods (.get/.run/.all) return
 * Effects instead of Promises, matching core's expected API.
 */
export const pgDatabaseLayer = Layer.sync(Database.Service, () =>
  Database.Service.of({ db: createBridgeDb() }),
)
