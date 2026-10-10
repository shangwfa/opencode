export * as DatabasePg from "./pg.js"

import { Context, Duration, Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { SqlClient } from "effect/unstable/sql"
import { classifySqliteError, SqlError, StatementTimeoutError } from "effect/unstable/sql/SqlError"
import { Reactivity } from "effect/unstable/reactivity"
import { Global } from "@opencode/util/global"
import postgres from "postgres"
import { Database } from "./database.js"
import { migrations } from "./migration.gen.js"
import { EffectDrizzleSqlite } from "./drizzle.js"
import { Sqlite } from "./sqlite.js"
import pgSchemaSql from "./pg-schema.sql" with { type: "text" }

const TypeId = "~@opencode/core/database/Pg" as const

const translateScalarMax = (query: string) => {
  let result = ""
  let quote = ""
  for (let i = 0; i < query.length; ) {
    if (quote) {
      const char = query[i]
      result += char
      if (char === quote && query[i + 1] === quote) result += query[++i]
      else if (char === quote) quote = ""
      i++
      continue
    }
    if (query[i] === "'" || query[i] === '"') {
      quote = query[i]
      result += query[i++]
      continue
    }
    if (query.slice(i, i + 3).toLowerCase() !== "max" || /[\w]/.test(query[i - 1] ?? "")) {
      result += query[i++]
      continue
    }
    let open = i + 3
    while (/\s/.test(query[open] ?? "")) open++
    if (query[open] !== "(") {
      result += query[i++]
      continue
    }
    let depth = 1
    let nestedQuote = ""
    let comma = -1
    let end = open + 1
    for (; end < query.length && depth > 0; end++) {
      const char = query[end]
      if (nestedQuote) {
        if (char === nestedQuote && query[end + 1] === nestedQuote) end++
        else if (char === nestedQuote) nestedQuote = ""
        continue
      }
      if (char === "'" || char === '"') nestedQuote = char
      else if (char === "(") depth++
      else if (char === ")") depth--
      else if (char === "," && depth === 1 && comma < 0) comma = end
    }
    if (depth !== 0 || comma < 0) {
      result += query[i++]
      continue
    }
    result += `GREATEST(${translateScalarMax(query.slice(open + 1, comma))}, ${translateScalarMax(query.slice(comma + 1, end - 1))})`
    i = end
  }
  return result
}

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
  pg = pg.replace(
    /(ON CONFLICT\s*\()([^)]*)(\))/gi,
    (_match, prefix: string, target: string, suffix: string) => `${prefix}${target.replace(/"[^"]+"\./g, "")}${suffix}`,
  )
  pg = translateScalarMax(pg)
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
 *
 * Exported for tests that verify the compatibility functions against a real PG.
 */
export const COMPAT_DDL = /* sql */ `
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
  -- btrim leaves '.key' after stripping '$', and the split of '.key' yields an
  -- empty first key; dropping empty keys makes jsonb_extract_path_text work.
  -- NOTE: this file is a JS template literal, so each PG-level backslash is
  -- written as a double backslash below (the class reaching PG is [\[\].]).
  keys := array_remove(
    regexp_split_to_array(btrim(path, ' $"'), '[\\[\\].]+'),
    ''
  );
  IF cardinality(keys) = 0 THEN RETURN NULL; END IF;
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

/**
 * A non-positive or unparsable value is a configuration mistake, not a request
 * to disable the guard: silently turning a timeout into 0 would restore the
 * unbounded hang this exists to prevent. Fall back to the default instead.
 */
const positiveMs = (env: Readonly<Record<string, string | undefined>>, name: string, fallback: number) => {
  const raw = env[name]
  if (raw === undefined) return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

export interface PostgresOptions {
  readonly max: number
  readonly prepare: boolean
  readonly onnotice: () => void
  readonly types: typeof PG_TYPES
  /** Handshake budget; a server-side GUC cannot cover a socket that never connects. */
  readonly connect_timeout: number
  /** Startup parameters — the only channel that reaches PG server-side GUCs. */
  readonly connection: {
    readonly statement_timeout: number
    readonly lock_timeout: number
    readonly idle_in_transaction_session_timeout: number
  }
  /** Client-side fallback for a half-open socket the server can never answer. */
  readonly queryTimeoutMs: number
  /** Reap connections abandoned by a client-side timeout. */
  readonly idle_timeout: number
  readonly max_lifetime: number
}

const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000
const DEFAULT_IDLE_TX_TIMEOUT_MS = 60_000
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000
const DEFAULT_IDLE_TIMEOUT_MS = 30_000
const DEFAULT_MAX_LIFETIME_MS = 600_000
// V1 defaulted the client bound to the same value as statement_timeout.
// Keep 0 as the default so the client is a strict fallback: a query PG can
// answer is always cancelled server-side first, with the real cause.
const DEFAULT_QUERY_GRACE_MS = 0

export const makePostgresOptions = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): PostgresOptions => {
  const statementTimeoutMs = positiveMs(env, "OPENCODE_PG_STATEMENT_TIMEOUT_MS", DEFAULT_STATEMENT_TIMEOUT_MS)
  return {
    max: 1,
    prepare: false,
    onnotice: () => {},
    types: PG_TYPES,
    // postgres.js takes connect_timeout in seconds.
    connect_timeout: positiveMs(env, "OPENCODE_PG_CONNECT_TIMEOUT_MS", DEFAULT_CONNECT_TIMEOUT_MS) / 1000,
    // A client-timed-out query leaves its half-open connection to postgres.js;
    // these bound how long such a connection can occupy the pool (V2 runs
    // max: 1, so a single leaked connection stalls every query behind it).
    idle_timeout: positiveMs(env, "OPENCODE_PG_IDLE_TIMEOUT_MS", DEFAULT_IDLE_TIMEOUT_MS) / 1000,
    max_lifetime: positiveMs(env, "OPENCODE_PG_MAX_LIFETIME_MS", DEFAULT_MAX_LIFETIME_MS) / 1000,
    connection: {
      statement_timeout: statementTimeoutMs,
      lock_timeout: statementTimeoutMs,
      // A client-timed-out query can abandon a connection mid-transaction; this
      // reaps it so a leaked one cannot starve the pool (max 1).
      idle_in_transaction_session_timeout: positiveMs(
        env,
        "OPENCODE_PG_IDLE_TX_TIMEOUT_MS",
        DEFAULT_IDLE_TX_TIMEOUT_MS,
      ),
    },
    // Wider than the server GUC on purpose: a normal slow query must be
    // cancelled by PG — which reports the real cause — before the client
    // fallback would fire. The client bound only catches requests that never
    // reach the server at all.
    queryTimeoutMs: statementTimeoutMs + positiveMs(env, "OPENCODE_PG_QUERY_GRACE_MS", DEFAULT_QUERY_GRACE_MS),
  }
}

/**
 * Bound one terminal query. postgres.js has no socket read/write timeout, so a
 * half-open connection hangs forever: connect_timeout only covers the
 * handshake, and a server-side statement_timeout cannot cancel a request that
 * never arrives. Without this the owning run never completes and the Session
 * stops responding (the 2026-08-21 incident).
 */
/**
 * Bind a terminal query executor to the client-side budget. Extracted so the
 * wiring itself is testable: a correct `withQueryTimeout` that nothing calls
 * would leave the 2026-08-21 hang in place.
 */
export const boundQuery = <A, E, R>(
  execute: Effect.Effect<A, E, R>,
  queryTimeoutMs: number,
): Effect.Effect<A, E | SqlError, R> => withQueryTimeout(execute, queryTimeoutMs)

export const withQueryTimeout = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  timeoutMs: number,
): Effect.Effect<A, E | SqlError, R> =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(timeoutMs),
      orElse: () =>
        Effect.fail(
          new SqlError({
            reason: new StatementTimeoutError({
              cause: new Error(`PG query timed out after ${timeoutMs}ms`),
              message: `PG query timed out after ${timeoutMs}ms`,
            }),
          }),
        ),
    }),
  )

const isPragma = (query: string) => /^\s*PRAGMA\b/i.test(query)

export const layer = (url: string): Layer.Layer<Database.Service, never, Global.Service> =>
  Layer.effect(
    Database.Service,
    Effect.gen(function* () {
      const global = yield* Global.Service
      const pgOptions = makePostgresOptions()
      const { queryTimeoutMs, ...clientOptions } = pgOptions
      const native = postgres(url, clientOptions)
      yield* Effect.addFinalizer(() => Effect.promise(() => native.end({ timeout: 5 })))
      // sqlite-shim views/functions must exist before migrations introspect.
      yield* Effect.tryPromise(() => native.unsafe(COMPAT_DDL))

      const run = (query: string, params: ReadonlyArray<unknown> = []) => {
        if (isPragma(query)) return Effect.succeed([])
        return boundQuery(
          Effect.tryPromise({
            try: async () =>
              (await native.unsafe(translate(query), [...params] as unknown as Parameters<
                typeof native.unsafe
              >[1])) as Array<Record<string, unknown>>,
            catch: (cause) =>
              new SqlError({
                reason: classifySqliteError(cause, { message: "Failed to execute statement", operation: "execute" }),
              }),
          }),
          queryTimeoutMs,
        )
      }
      const runValues = (query: string, params: ReadonlyArray<unknown> = []) => {
        if (isPragma(query)) return Effect.succeed([])
        return boundQuery(
          Effect.tryPromise({
            try: async () => {
              const rows = await native.unsafe(translate(query), [...params] as unknown as Parameters<
                typeof native.unsafe
              >[1])
              return (rows as Array<Record<string, unknown>>).map((row) => Object.values(row))
            },
            catch: (cause) =>
              new SqlError({
                reason: classifySqliteError(cause, {
                  message: "Failed to execute statement",
                  operation: "executeValues",
                }),
              }),
          }),
          queryTimeoutMs,
        )
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
        yield* db.run(
          sql`CREATE TABLE IF NOT EXISTS "migration" ("id" text PRIMARY KEY, "time_completed" bigint NOT NULL)`,
        )
        // The bootstrap dump already contains the complete schema at this
        // revision, so record its migrations without replaying their ALTERs.
        for (const migration of migrations) {
          yield* db.run(
            sql`INSERT INTO "migration" ("id", "time_completed") VALUES (${migration.id}, ${Date.now()}) ON CONFLICT ("id") DO NOTHING`,
          )
        }
      } else {
        yield* db.run(
          sql`CREATE TABLE IF NOT EXISTS "migration" ("id" text PRIMARY KEY, "time_completed" bigint NOT NULL)`,
        )
        const completed = new Set(
          (yield* db.all<{ id: string }>(sql`SELECT "id" FROM "migration"`)).map((row) => row.id),
        )
        for (const migration of migrations) {
          if (completed.has(migration.id)) continue
          yield* db.transaction((tx) =>
            Effect.gen(function* () {
              yield* migration.up(tx).pipe(Effect.provideService(Global.Service, global))
              yield* tx.run(
                sql`INSERT INTO "migration" ("id", "time_completed") VALUES (${migration.id}, ${Date.now()})`,
              )
            }),
          )
        }
      }
      // Transaction-scoped: covers absent sequence rows as well as existing
      // aggregates, and is released by PG on commit/rollback/connection loss.
      // Hash collisions only serialize unrelated aggregates; they do not
      // weaken exclusion. The prefix separates this lock namespace from
      // other advisory-lock users.
      const lockAggregate = Effect.fn("DatabasePg.lockAggregate")(function* (aggregateID: string) {
        yield* db.run(sql`SELECT pg_advisory_xact_lock(hashtextextended(${"opencode:event:" + aggregateID}, 0))`)
      })
      // postgres.js LISTEN uses its own connection; notifications arrive on a
      // dedicated socket so listener failures never stall the query pool.
      const eventFanout = {
        notify: (channel: string, payload: string) =>
          Effect.tryPromise({
            try: () => native.notify(channel, payload),
            catch: (cause) =>
              new SqlError({
                reason: classifySqliteError(cause, { message: "PG NOTIFY failed", operation: "execute" }),
              }),
          }).pipe(Effect.orDie),
        listen: (channel: string, onNotify: (payload: string) => void) =>
          Effect.tryPromise({
            // sql.listen uses a dedicated plain LISTEN connection (no logical
            // replication); the returned thenable resolves to an unlisten handle.
            try: () => native.listen(channel, onNotify).then((meta) => () => meta.unlisten()),
            catch: (cause) =>
              new SqlError({
                reason: classifySqliteError(cause, { message: "PG LISTEN failed", operation: "execute" }),
              }),
          }).pipe(
            Effect.orDie,
            Effect.map((close) => () => Effect.promise(() => close())),
          ),
      }
      return {
        db,
        dialect: "postgres" as const,
        lockAggregate: (aggregateID: string) => lockAggregate(aggregateID).pipe(Effect.orDie),
        eventFanout,
      }
    }).pipe(Effect.orDie),
  )
