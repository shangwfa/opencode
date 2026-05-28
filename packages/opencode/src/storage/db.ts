import { sql } from "drizzle-orm"
export * from "drizzle-orm"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LocalContext } from "@/util/local-context"
import { lazy } from "@/util/lazy"
import * as Log from "@opencode-ai/core/util/log"
import { NamedError } from "@opencode-ai/core/util/error"
import path from "path"
import { readFileSync, readdirSync, existsSync } from "fs"
import { Flag } from "@opencode-ai/core/flag/flag"
import { EffectBridge } from "@/effect/bridge"
import { Effect, Schema } from "effect"
import { createHash } from "crypto"

declare const OPENCODE_MIGRATIONS: { sql: string; timestamp: number; name: string }[] | undefined

export const NotFoundError = NamedError.create("NotFoundError", {
  message: Schema.String,
})

const log = Log.create({ service: "db" })

export const dialect = "pg" as const

export const getPath = () => {
  if (!Flag.OPENCODE_DATABASE_URL) {
    throw new Error("OPENCODE_DATABASE_URL is required for PostgreSQL mode")
  }
  return Flag.OPENCODE_DATABASE_URL
}

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
      await db.transaction(async (tx: any) => {
        for (const stmt of stmts) {
          await tx.execute(sql.raw(stmt))
        }
        await tx.execute(sql`INSERT INTO __drizzle_migrations (hash, created_at) VALUES (${hash}, ${entry.timestamp})`)
      })
    }
  } finally {
    try {
      await db.execute(sql`SELECT pg_advisory_unlock(${lockId})`)
    } catch {}
  }
}

let pgClose: (() => Promise<void>) | undefined
let pendingMigrations: Journal | undefined

export const Client = lazy(() => {
  const url = Flag.OPENCODE_DATABASE_URL!
  log.info("opening pg database", { url: url.replace(/:[^:@]*@/, ":***@") })
  const pg = require("../storage/db.pg") as typeof import("../storage/db.pg")
  const { db, client } = pg.init(url)
  pgClose = () => client.end()

  const { ProjectTable } = require("../project/project.pg") as typeof import("../project/project.pg")
  pg.install(db, ProjectTable)

  const dir = path.join(import.meta.dirname, "../../migration-pg")
  pendingMigrations =
    typeof OPENCODE_MIGRATIONS !== "undefined" ? OPENCODE_MIGRATIONS : existsSync(dir) ? migrations(dir) : []

  return db as TxOrDb
})

let initialized = false
export async function initialize() {
  if (initialized) return
  const client = Client()
  if (pendingMigrations && pendingMigrations.length > 0) {
    const flags = Effect.runSync(RuntimeFlags.Service.useSync((flags) => flags).pipe(Effect.provide(RuntimeFlags.defaultLayer)))
    if (!flags.skipMigrations) {
      log.info("applying pg migrations", { count: pendingMigrations.length })
      await migratePg(client, pendingMigrations)
    }
    pendingMigrations = undefined
  }
  initialized = true
}

export async function close() {
  if (pgClose) {
    await pgClose()
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
  const bound = EffectBridge.bind(fn)
  try {
    ctx.use().effects.push(bound)
  } catch {
    bound()
  }
}

export async function transaction<T>(
  callback: (tx: TxOrDb) => T | Promise<T>,
): Promise<T> {
  try {
    return await callback(ctx.use().tx)
  } catch (err) {
    if (err instanceof LocalContext.NotFound) {
      const effects: (() => void | Promise<void>)[] = []

      const pgDb = Client()
      const result = await pgDb.transaction(async (tx: TxOrDb) => {
        return ctx.provide({ tx, effects }, () => callback(tx))
      })

      for (const effect of effects) effect()
      return result
    }
    throw err
  }
}

export * as Database from "./db"
