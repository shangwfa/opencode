import { type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import { migrate as migrateSqlite } from "drizzle-orm/bun-sqlite/migrator"
import { type SQLiteTransaction } from "drizzle-orm/sqlite-core"
import { sql } from "drizzle-orm"
export * from "drizzle-orm"
import { LocalContext } from "../util/local-context"
import { lazy } from "../util/lazy"
import { Global } from "../global"
import { Log } from "../util/log"
import { NamedError } from "@opencode-ai/shared/util/error"
import z from "zod"
import path from "path"
import { readFileSync, readdirSync, existsSync } from "fs"
import { Flag } from "../flag/flag"
import { CHANNEL } from "../installation/meta"
import { InstanceState } from "@/effect/instance-state"
import { iife } from "@/util/iife"
import { init as initSqlite } from "#db"
import { createHash } from "crypto"

declare const OPENCODE_MIGRATIONS: { sql: string; timestamp: number; name: string }[] | undefined

export const NotFoundError = NamedError.create(
  "NotFoundError",
  z.object({
    message: z.string(),
  }),
)

const log = Log.create({ service: "db" })

export namespace Database {
  export type Dialect = "sqlite" | "pg"

  export const dialect: Dialect = Flag.OPENCODE_DATABASE_URL ? "pg" : "sqlite"

  export function getChannelPath() {
    if (["latest", "beta", "prod"].includes(CHANNEL) || Flag.OPENCODE_DISABLE_CHANNEL_DB)
      return path.join(Global.Path.data, "opencode.db")
    const safe = CHANNEL.replace(/[^a-zA-Z0-9._-]/g, "-")
    return path.join(Global.Path.data, `opencode-${safe}.db`)
  }

  export const Path = iife(() => {
    if (Flag.OPENCODE_DATABASE_URL) return Flag.OPENCODE_DATABASE_URL
    if (Flag.OPENCODE_DB) {
      if (Flag.OPENCODE_DB === ":memory:" || path.isAbsolute(Flag.OPENCODE_DB)) return Flag.OPENCODE_DB
      return path.join(Global.Path.data, Flag.OPENCODE_DB)
    }
    return getChannelPath()
  })

  // SQLite types
  export type SqliteTransaction = SQLiteTransaction<"sync", void>
  type SqliteClient = SQLiteBunDatabase

  // Unified type — `any` is intentional here to avoid coupling to
  // both pg-core and sqlite-core type systems in every consumer.
  // Consumers already access the db through Drizzle's query builder
  // which is structurally compatible across dialects.
  export type TxOrDb = any

  type Journal = { sql: string; timestamp: number; name: string }[]

  function time(tag: string) {
    const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(tag)
    if (!match) return 0
    return Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6]),
    )
  }

  function migrations(dir: string): Journal {
    const dirs = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)

    const result = dirs
      .map((name) => {
        const file = path.join(dir, name, "migration.sql")
        if (!existsSync(file)) return
        return {
          sql: readFileSync(file, "utf-8"),
          timestamp: time(name),
          name,
        }
      })
      .filter(Boolean) as Journal

    return result.sort((a, b) => a.timestamp - b.timestamp)
  }

  // PG custom migration executor (since drizzle-orm/postgres-js/migrator
  // does not support inline migration arrays)
  async function migratePg(db: any, entries: Journal) {
    const lockId = 20191001
    await db.execute(sql`SELECT pg_advisory_lock(${lockId})`)
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
        const rows = await db.execute(sql`SELECT 1 FROM __drizzle_migrations WHERE hash = ${hash}`)
        if (rows.length > 0) continue
        const stmts = entry.sql.split("--> statement-breakpoint").filter((s: string) => s.trim())
        for (const stmt of stmts) {
          await db.execute(sql.raw(stmt))
        }
        await db.execute(sql`INSERT INTO __drizzle_migrations (hash, created_at) VALUES (${hash}, ${entry.timestamp})`)
      }
    } finally {
      try {
        await db.execute(sql`SELECT pg_advisory_unlock(${lockId})`)
      } catch {
        // Connection may have dropped; advisory lock releases on disconnect
      }
    }
  }

  // Internal state for PG mode
  let pgClose: (() => Promise<void>) | undefined
  let pendingMigrations: Journal | undefined

  export const Client = lazy(() => {
    if (dialect === "pg") {
      const url = Flag.OPENCODE_DATABASE_URL!
      log.info("opening pg database", { url: url.replace(/:[^:@]*@/, ":***@") })
      const pg = require("../storage/db.pg") as typeof import("../storage/db.pg")
      const { db, client } = pg.init(url)
      pgClose = () => client.end()

      // Install .run()/.get()/.all() shims so business code written
      // against the SQLite query API works on PG too.
      const { ProjectTable } = require("../project/project.pg") as typeof import("../project/project.pg")
      pg.install(db, ProjectTable)

      // Store migrations for async init
      const dir = path.join(import.meta.dirname, "../../migration-pg")
      pendingMigrations =
        typeof OPENCODE_MIGRATIONS !== "undefined" ? OPENCODE_MIGRATIONS : existsSync(dir) ? migrations(dir) : []

      return db as TxOrDb
    }

    log.info("opening database", { path: Path })
    const db = initSqlite(Path)

    db.run("PRAGMA journal_mode = WAL")
    db.run("PRAGMA synchronous = NORMAL")
    db.run("PRAGMA busy_timeout = 5000")
    db.run("PRAGMA cache_size = -64000")
    db.run("PRAGMA foreign_keys = ON")
    db.run("PRAGMA wal_checkpoint(PASSIVE)")

    // Apply schema migrations
    const entries =
      typeof OPENCODE_MIGRATIONS !== "undefined"
        ? OPENCODE_MIGRATIONS
        : migrations(path.join(import.meta.dirname, "../../migration"))
    if (entries.length > 0) {
      log.info("applying migrations", {
        count: entries.length,
        mode: typeof OPENCODE_MIGRATIONS !== "undefined" ? "bundled" : "dev",
      })
      if (Flag.OPENCODE_SKIP_MIGRATIONS) {
        for (const item of entries) {
          item.sql = "select 1;"
        }
      }
      migrateSqlite(db, entries)
    }

    return db as TxOrDb
  })

  // Async initialization — must be called once at startup for PG mode
  // For SQLite this is a no-op
  let initialized = false
  export async function initialize() {
    if (initialized) return
    const client = Client()
    if (dialect === "pg" && pendingMigrations && pendingMigrations.length > 0) {
      if (!Flag.OPENCODE_SKIP_MIGRATIONS) {
        log.info("applying pg migrations", { count: pendingMigrations.length })
        await migratePg(client, pendingMigrations)
      }
      pendingMigrations = undefined
    }
    initialized = true
  }

  export async function close() {
    if (dialect === "pg" && pgClose) {
      await pgClose()
    } else {
      ;(Client() as any).$client.close()
    }
    Client.reset()
    initialized = false
  }

  const ctx = LocalContext.create<{
    tx: TxOrDb
    effects: (() => void | Promise<void>)[]
  }>("database")

  export async function use<T>(callback: (trx: TxOrDb) => T | Promise<T>): Promise<T> {
    try {
      return await callback(ctx.use().tx)
    } catch (err) {
      if (err instanceof LocalContext.NotFound) {
        const effects: (() => void | Promise<void>)[] = []
        const result = await ctx.provide({ effects, tx: Client() }, () => callback(Client()))
        for (const effect of effects) effect()
        return result
      }
      throw err
    }
  }

  export function effect(fn: () => any | Promise<any>) {
    const bound = InstanceState.bind(fn)
    try {
      ctx.use().effects.push(bound)
    } catch {
      bound()
    }
  }

  export async function transaction<T>(
    callback: (tx: TxOrDb) => T | Promise<T>,
    options?: {
      behavior?: "deferred" | "immediate" | "exclusive"
    },
  ): Promise<T> {
    try {
      return await callback(ctx.use().tx)
    } catch (err) {
      if (err instanceof LocalContext.NotFound) {
        const effects: (() => void | Promise<void>)[] = []

        let result: T
        if (dialect === "pg") {
          const pgDb = Client()
          // Map SQLite behavior to PG isolation level
          const config =
            options?.behavior === "immediate" || options?.behavior === "exclusive"
              ? ({ isolationLevel: "read committed" } as const)
              : undefined
          if (config) {}
          result = await pgDb.transaction(async (tx: TxOrDb) => {
            return ctx.provide({ tx, effects }, () => callback(tx))
          }, config)
        } else {
          const sqliteDb = Client()
          // SQLite transaction is sync, but callback may be async.
          // We run the sync transaction then await any Promise result.
          const txCallback = InstanceState.bind((tx: TxOrDb) => ctx.provide({ tx, effects }, () => callback(tx)))
          const raw = sqliteDb.transaction(txCallback, { behavior: options?.behavior })
          result = (await raw) as T
        }

        for (const effect of effects) effect()
        return result
      }
      throw err
    }
  }
}
