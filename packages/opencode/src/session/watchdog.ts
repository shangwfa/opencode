import { Context, Duration, Effect, Layer, Schedule } from "effect"
import { and, sql } from "drizzle-orm"
import * as Log from "@opencode-ai/core/util/log"
import { Database } from "../storage/db"
import { PartTable } from "./session.pg"
import type { PartID } from "./schema"
import { SessionTools } from "./mark-timed-out"

const log = Log.create({ service: "watchdog" })

export interface Config {
  readonly scanInterval: ReturnType<typeof Duration.seconds>
  readonly initialDelay: ReturnType<typeof Duration.seconds>
  readonly timeoutMs: number
}

export const defaultConfig: Config = {
  scanInterval: Duration.seconds(60),
  initialDelay: Duration.seconds(10),
  timeoutMs: 5 * 60 * 1000,
}

type WatchdogRow = Pick<typeof PartTable.$inferSelect, "id" | "session_id" | "data">
type WatchdogDb = {
  select(input: { id: typeof PartTable.id; session_id: typeof PartTable.session_id; data: typeof PartTable.data }): {
    from(table: typeof PartTable): {
      where(condition: ReturnType<typeof and>): {
        all(): Promise<WatchdogRow[]>
      }
    }
  }
}

export interface Interface {
  readonly enabled: true
  readonly scanOnce: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionWatchdog") {}

function parsePartData(data: unknown): unknown {
  if (typeof data !== "string") return data
  try {
    return JSON.parse(data)
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function runningStart(data: unknown): number | undefined {
  const value = parsePartData(data)
  if (!isRecord(value)) return
  if (value.type !== "tool") return
  if (!isRecord(value.state)) return
  if (value.state.status !== "running") return
  if (!isRecord(value.state.time)) return
  if (typeof value.state.time.start !== "number") return
  return value.state.time.start
}

const MONITORED_TOOLS = ["read", "write", "edit", "apply_patch", "glob", "grep", "ls"] as const

function runningToolCondition(startBefore: number) {
  const toolList = sql.raw(MONITORED_TOOLS.map((t) => `'${t}'`).join(", "))
  if (Database.dialect === "pg") {
    return and(
      sql`${PartTable.data}->>'type' = 'tool'`,
      sql`${PartTable.data}->>'tool' IN (${toolList})`,
      sql`${PartTable.data}->'state'->>'status' = 'running'`,
      sql`(${PartTable.data}->'state'->'time'->>'start')::bigint < ${startBefore}`,
    )
  }
  return and(
    sql`json_extract(${PartTable.data}, '$.type') = 'tool'`,
    sql`json_extract(${PartTable.data}, '$.tool') IN (${toolList})`,
    sql`json_extract(${PartTable.data}, '$.state.status') = 'running'`,
    sql`json_extract(${PartTable.data}, '$.state.time.start') < ${startBefore}`,
  )
}
const scan = Effect.fn("SessionWatchdog.scan")(function* (config: Config) {
  const db = Database.Client() as WatchdogDb
  const tools = yield* SessionTools.Service
  const t0 = Date.now()
  const startBefore = t0 - config.timeoutMs
  const span = yield* Effect.currentSpan

  const rows = yield* Effect.tryPromise({
    try: () =>
      db
        .select({
          id: PartTable.id,
          session_id: PartTable.session_id,
          data: PartTable.data,
        })
        .from(PartTable)
        .where(runningToolCondition(startBefore))
        .all(),
    catch: (error) => new Error(`watchdog scan query failed: ${String(error)}`),
  }).pipe(
    Effect.catchCause((cause) => {
      log.error("watchdog scan query failed", { cause: String(cause) })
      return Effect.succeed([] as WatchdogRow[])
    }),
  )

  const stuck = rows
    .map((row) => {
      const start = runningStart(row.data)
      if (start === undefined) return
      return { row, start }
    })
    .filter((item) => item !== undefined)

  const results = yield* Effect.forEach(
    stuck,
    (item) =>
      tools
        .markTimedOut({ partID: item.row.id, expectedStart: item.start, timeoutMs: config.timeoutMs })
        .pipe(Effect.catchCause(() => Effect.succeed(false))),
    { concurrency: 4 },
  )
  const marked = results.filter(Boolean).length
  const durationMs = Date.now() - t0

  span.attribute("watchdog.scanned", rows.length)
  span.attribute("watchdog.stuck", stuck.length)
  span.attribute("watchdog.marked", marked)
  span.attribute("watchdog.duration_ms", durationMs)

  if (stuck.length > 0) log.warn("watchdog stuck tools detected", { count: stuck.length, marked })
  log.info("watchdog scan completed", {
    scanned: rows.length,
    stuck: stuck.length,
    marked,
    durationMs,
  })
})

export const layerWithConfig = (config: Config) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const tools = yield* SessionTools.Service
      const scanOnce = scan(config).pipe(
        Effect.provideService(SessionTools.Service, tools),
        Effect.catchCause((cause) => {
          log.error("watchdog iteration failed", { cause: String(cause) })
          return Effect.void
        }),
      )
      yield* scanOnce.pipe(
        Effect.repeat(Schedule.spaced(config.scanInterval)),
        Effect.delay(config.initialDelay),
        Effect.forkScoped,
      )
      return Service.of({ enabled: true, scanOnce })
    }),
  )

export const layer = layerWithConfig(defaultConfig)

export const defaultLayer = layer

export * as SessionWatchdog from "./watchdog"
