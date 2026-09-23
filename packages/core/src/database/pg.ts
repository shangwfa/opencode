export * as DatabasePg from "./pg.js"

import { Context, Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { SqlClient } from "effect/unstable/sql"
import { classifySqliteError, SqlError } from "effect/unstable/sql/SqlError"
import { Reactivity } from "effect/unstable/reactivity"
import { Global } from "@opencode/util/global"
import postgres from "postgres"
import { Database } from "./database.js"
import { migrations } from "./migration.gen.js"
import { EffectDrizzleSqlite } from "./drizzle.js"
import { Sqlite } from "./sqlite.js"
import pgSchemaSql from "./pg-schema.sql" with { type: "text" }

const TypeId = "~@opencode/core/database/Pg" as const

/**
 * Translates the sqlite-dialect SQL emitted by drizzle (and raw callers) into
 * PostgreSQL. Covers the constructs this repository actually emits:
 *
 *  - `?` placeholders          -> `$n`
 *  - backtick identifiers      -> double-quoted identifiers
 *  - `integer` columns         -> `bigint` (ms-since-epoch timestamps overflow int4)
 *  - `integer PRIMARY KEY AUTOINCREMENT` -> `serial PRIMARY KEY`
 *  - `DEFAULT true/false`      -> `DEFAULT 1/0` (boolean defaults on integer columns)
 *  - `INSERT OR IGNORE INTO`   -> `ON CONFLICT DO NOTHING`
 *  - `BEGIN DEFERRED/IMMEDIATE/EXCLUSIVE` -> `BEGIN`
 *
 * sqlite-specific objects (`sqlite_master`, `pragma_table_info`) and functions
 * (`json_extract`, `strftime`) are provided as PG views/functions by COMPAT_DDL
 * below, so caller SQL passes through unmodified.
 */
const translate = (query: string): string => {
  let out = ""
  let n = 0
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < query.length; i++) {
    const ch = query[i]
    if (ch === "'" && !inDouble) inSingle = !inSingle
    else if (ch === '"' && !inSingle) inDouble = !inDouble
    if (ch === "?" && !inSingle && !inDouble) {
      out += `$${++n}`
      continue
    }
    out += ch
  }
  let pg = out.replace(/`/g, '"')
  pg = pg.replace(/\bbegin\s+(deferred|immediate|exclusive)\b/gi, "BEGIN")
  pg = pg.replace(/\binteger\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/gi, "serial PRIMARY KEY")
  pg = pg.replace(/\bDEFAULT\s+false\b/gi, "DEFAULT 0")
  pg = pg.replace(/\bDEFAULT\s+true\b/gi, "DEFAULT 1")
  pg = pg.replace(/\bblob\b/gi, "bytea")
  pg = pg.replace(/\breal\b/gi, "double precision")
  pg = pg.replace(/\bnumeric\b/gi, "double precision")
  pg = pg.replace(/\binteger\b/gi, "bigint")
  if (/insert\s+or\s+ignore\s+into/i.test(pg)) {
    pg = pg.replace(/insert\s+or\s+ignore\s+into/i, "INSERT INTO").replace(/\s*;\s*$/, "")
    pg += " ON CONFLICT DO NOTHING"
  }
  return pg
}

/**
 * PG objects that emulate the sqlite surface this repository relies on:
 * `sqlite_master` / `pragma_table_info` for schema introspection, and
 * `json_extract` / `strftime` so raw caller SQL keeps working.
 */
const COMPAT_DDL = /* sql */ `
CREATE OR REPLACE VIEW sqlite_master AS
  SELECT tablename AS name, 'table'::text AS type FROM pg_tables WHERE schemaname = 'public'
  UNION ALL
  SELECT viewname AS name, 'view'::text AS type FROM pg_views WHERE schemaname = 'public';

CREATE OR REPLACE FUNCTION pragma_table_info(tbl text) RETURNS TABLE(name text) AS $$
  SELECT column_name FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = lower(tbl)
  ORDER BY ordinal_position
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION json_extract(target text, path text) RETURNS text AS $$
DECLARE
  keys text[];
BEGIN
  IF target IS NULL OR path IS NULL THEN RETURN NULL; END IF;
  IF btrim(path) = '$' THEN RETURN target; END IF;
  keys := regexp_split_to_array(btrim(path, ' $"'), '[\\[\\].]+');
  RETURN jsonb_extract_path_text(target::jsonb, VARIADIC keys);
EXCEPTION WHEN others THEN RETURN NULL;
END
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION strftime(fmt text, ts double precision, modifier text) RETURNS text AS $$
DECLARE
  out text := fmt;
BEGIN
  IF modifier IS NOT NULL AND lower(modifier) <> 'unixepoch' THEN RETURN NULL; END IF;
  out := replace(out, '%Y', 'YYYY');
  out := replace(out, '%m', 'MM');
  out := replace(out, '%d', 'DD');
  out := replace(out, '%H', 'HH24');
  out := replace(out, '%M', 'MI');
  out := replace(out, '%S', 'SS');
  out := replace(out, '%j', 'DDD');
  out := replace(out, '%f', 'US');
  RETURN to_char(to_timestamp(ts), out);
END
$$ LANGUAGE plpgsql;
`

// postgres.js returns int8 as strings by default; every bigint column here
// carries ms timestamps or counters well below 2^53, so parse to numbers.
const PG_TYPES = {
  int8: {
    to: 20,
    from: [20],
    serialize: (value: number | string) => String(value),
    parse: (value: string) => Number(value),
  },
}

const isPragma = (query: string) => /^\s*PRAGMA\b/i.test(query)

export const layer = (url: string): Layer.Layer<Database.Service, never, Global.Service> =>
  Layer.effect(
    Database.Service,
    Effect.gen(function* () {
      const global = yield* Global.Service
      const native = postgres(url, {
        max: 1,
        prepare: false,
        onnotice: () => {},
        types: PG_TYPES,
      })
      yield* Effect.addFinalizer(() => Effect.promise(() => native.end({ timeout: 5 })))
      // sqlite-shim views/functions must exist before migrations introspect.
      yield* Effect.tryPromise(() => native.unsafe(COMPAT_DDL))

      const run = (query: string, params: ReadonlyArray<unknown> = []) => {
        if (isPragma(query)) return Effect.succeed([])
        return Effect.tryPromise({
          try: async () =>
            (await native.unsafe(
              translate(query),
              [...params] as unknown as Parameters<typeof native.unsafe>[1],
            )) as Array<Record<string, unknown>>,
          catch: (cause) =>
            new SqlError({
              reason: classifySqliteError(cause, { message: "Failed to execute statement", operation: "execute" }),
            }),
        })
      }
      const runValues = (query: string, params: ReadonlyArray<unknown> = []) => {
        if (isPragma(query)) return Effect.succeed([])
        return Effect.tryPromise({
          try: async () => {
            const rows = await native.unsafe(
              translate(query),
              [...params] as unknown as Parameters<typeof native.unsafe>[1],
            )
            return (rows as Array<Record<string, unknown>>).map((row) => Object.values(row))
          },
          catch: (cause) =>
            new SqlError({
              reason: classifySqliteError(cause, { message: "Failed to execute statement", operation: "executeValues" }),
            }),
        })
      }

      const connection = Sqlite.makeConnection(run, runValues, {})
      const reactivity = Context.getUnsafe(yield* Reactivity.layer.pipe(Layer.build), Reactivity.Reactivity)
      const client = yield* Sqlite.makeClient({}, connection, TypeId, () => ({})).pipe(
        Effect.provideService(Reactivity.Reactivity, reactivity),
      )
      const db = yield* EffectDrizzleSqlite.makeWithDefaults().pipe(
        Effect.provideService(SqlClient.SqlClient, client),
        Effect.provideService(Reactivity.Reactivity, reactivity),
      )

      // PG 引导：sqlite 迁移链是 sqlite 方言，无法在 PG 上回放；改为执行等价的
      // PG DDL（由 dump-pg-schema.ts 从 sqlite 迁移链导出，先建表后补 FK）。journal
      // 表的存在即引导完成的标记；后续增量 PG 迁移按 journal 追加。
      const journal = yield* db.all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migration'`,
      )
      if (journal.length === 0) {
        for (const statement of pgSchemaSql.split(/;[ \t]*\r?\n/)) {
          if (statement.trim().length === 0) continue
          yield* db.run(sql.raw(statement))
        }
      }
      yield* db.run(
        sql`CREATE TABLE IF NOT EXISTS "migration" ("id" text PRIMARY KEY, "time_completed" bigint NOT NULL)`,
      )
      for (const migration of migrations) {
        yield* db.run(
          sql`INSERT INTO "migration" ("id", "time_completed") VALUES (${migration.id}, ${Date.now()}) ON CONFLICT ("id") DO NOTHING`,
        )
      }
      return { db }
    }).pipe(Effect.orDie),
  )
