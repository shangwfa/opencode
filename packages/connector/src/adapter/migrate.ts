export * as ConnectorMigrate from "./migrate.js"

import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

const migrationLockNamespace = 1_326_382_671
const migrationLockId = 1

/**
 * Resolves the first schema of libpq's `search_path` from a connection string. libpq accepts
 * both `options=-c search_path=xxx` (raw space) and the URL-encoded `-c%20search_path%3Dxxx`,
 * so the separator matches `=` in either form and the captured value is decoded before the
 * leading-schema split. Anything unparsable falls back to the "connector" schema.
 */
export function resolveSearchPath(connectionString: string): string {
  const captured = /search_path(?:=|%3d)([^&]+)/i.exec(connectionString)?.[1]
  let decoded = captured
  if (decoded !== undefined) {
    try {
      decoded = decodeURIComponent(decoded)
    } catch {
      // Capture was not valid percent-encoding; keep it verbatim for the split below.
    }
  }
  return decoded?.split(",")[0]?.trim() || "connector"
}

/**
 * Applies the engine's bundled PostgreSQL migrations (same protocol as the upstream
 * `runtime:migrate` entry point: advisory lock + `runtime_migrations` ledger). The engine
 * only asserts schema readiness at startup; this must run from a deploy migration job first.
 */
export async function runPostgresMigrations(options: {
  connectionString: string
  migrationDirectory: string
  log?: (message: string) => void
}): Promise<void> {
  const { Pool } = await import("pg")
  const pool = new Pool({ connectionString: options.connectionString, max: 1, application_name: "opencode-connector-migrate" })
  const client = await pool.connect()
  try {
    // The bundled migrations use unqualified table names; they land in the schema selected by the
    // connection's search_path, which upstream migration SQL never creates itself.
    const searchPath = resolveSearchPath(options.connectionString)
    await client.query(`create schema if not exists "${searchPath.replace(/"/g, '""')}"`)
    await client.query("select pg_advisory_lock($1, $2)", [migrationLockNamespace, migrationLockId])
    await client.query("create table if not exists runtime_migrations (name text primary key, applied_at text not null)")
    const directory = join(options.migrationDirectory, "postgresql")
    const files = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort()
    const applied = new Set((await client.query<{ name: string }>("select name from runtime_migrations")).rows.map((row) => row.name))
    for (const file of files) {
      if (applied.has(file)) continue
      options.log?.(`applying ${file}`)
      await client.query("begin")
      try {
        await client.query(await readFile(join(directory, file), "utf8"))
        await client.query("insert into runtime_migrations (name, applied_at) values ($1, $2)", [file, new Date().toISOString()])
        await client.query("commit")
      } catch (error) {
        await client.query("rollback")
        throw error
      }
    }
  } finally {
    try {
      await client.query("select pg_advisory_unlock($1, $2)", [migrationLockNamespace, migrationLockId])
    } catch {
      client.release(true)
      await pool.end()
      return
    }
    client.release()
    await pool.end()
  }
}
