import { pgTable, text, integer, bigint, index, uniqueIndex } from "drizzle-orm/pg-core"
import { and, desc, eq, inArray, lt, max, or, sql } from "drizzle-orm"
import { Timestamps, pgJsonb } from "../storage/schema.pg"
import { ProjectTable } from "../project/project.pg"
import { SessionTable } from "../session/session.pg"
import { Database } from "../storage/db"
import type { TxOrDb } from "../storage/db"
import { Log } from "@opencode-ai/core/util/log"

const log = Log.create({ service: "rpa" })

/** 12h：脚本执行带超时上限，12h 仍 running 必然是执行实例已死。 */
export const STALE_RUN_MS = 12 * 60 * 60 * 1000

export type RpaAppStatus = "active" | "disabled"
export type RpaVersionStatus = "candidate" | "active" | "retired"
export type RpaVersionSource = "exploration" | "repair" | "manual"
export type RpaRunTrigger = "api" | "cron" | "manual" | "validate"
export type RpaRunStatus = "pending" | "running" | "repairing" | "succeeded" | "failed" | "cancelled"

export const RpaAppTable = pgTable(
  "rpa_app",
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    directory: text().notNull(),
    name: text().notNull(),
    description: text(),
    status: text().$type<RpaAppStatus>().notNull().default("active"),
    params_schema: pgJsonb<Record<string, unknown>>(),
    ...Timestamps,
  },
  (table) => [index("rpa_app_project_idx").on(table.project_id)],
)

export const RpaAppVersionTable = pgTable(
  "rpa_app_version",
  {
    id: text().primaryKey(),
    app_id: text()
      .notNull()
      .references(() => RpaAppTable.id, { onDelete: "cascade" }),
    version: integer().notNull(),
    status: text().$type<RpaVersionStatus>().notNull().default("candidate"),
    source: text().$type<RpaVersionSource>().notNull(),
    script: text().notNull(),
    exploration: text(),
    manifest: pgJsonb<Record<string, unknown>>(),
    note: text(),
    repair_from_version: integer(),
    validate_run_id: text(),
    ...Timestamps,
  },
  (table) => [
    uniqueIndex("rpa_app_version_unique").on(table.app_id, table.version),
    uniqueIndex("rpa_app_version_one_active")
      .on(table.app_id)
      .where(sql`${table.status} = 'active'`),
    index("rpa_app_version_status_idx").on(table.app_id, table.status),
  ],
)

export const RpaAppRunTable = pgTable(
  "rpa_app_run",
  {
    id: text().primaryKey(),
    app_id: text()
      .notNull()
      .references(() => RpaAppTable.id, { onDelete: "cascade" }),
    version_id: text()
      .notNull()
      .references(() => RpaAppVersionTable.id, { onDelete: "cascade" }),
    trigger_type: text().$type<RpaRunTrigger>().notNull(),
    status: text().$type<RpaRunStatus>().notNull().default("pending"),
    params: pgJsonb<Record<string, unknown>>(),
    result: pgJsonb<Record<string, unknown>>(),
    error: text(),
    exit_code: integer(),
    repair_count: integer().notNull().default(0),
    repair_tokens: integer().notNull().default(0),
    repair_session_id: text().references(() => SessionTable.id, { onDelete: "set null" }),
    repaired_version_id: text().references(() => RpaAppVersionTable.id, { onDelete: "set null" }),
    run_session_id: text().references(() => SessionTable.id, { onDelete: "set null" }),
    time_started: bigint({ mode: "number" }),
    time_finished: bigint({ mode: "number" }),
    ...Timestamps,
  },
  (table) => [
    index("rpa_app_run_app_idx").on(table.app_id, table.time_created),
    index("rpa_app_run_status_idx").on(table.status),
  ],
)

export type RpaApp = typeof RpaAppTable.$inferSelect
export type NewRpaApp = typeof RpaAppTable.$inferInsert
export type RpaAppVersion = typeof RpaAppVersionTable.$inferSelect
export type NewRpaAppVersion = typeof RpaAppVersionTable.$inferInsert
export type RpaAppRun = typeof RpaAppRunTable.$inferSelect
export type NewRpaAppRun = typeof RpaAppRunTable.$inferInsert

const randomId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`

export const newRpaAppId = () => randomId("rpa")
export const newRpaVersionId = () => randomId("rpaver")
export const newRpaRunId = () => randomId("rparun")

function requireRow<T>(row: T | undefined, id: string, kind: string): T {
  if (row === undefined) throw new Error(`${kind} not found: ${id}`)
  return row
}

export async function insertRpaApp(row: Omit<NewRpaApp, "time_created" | "time_updated">) {
  const now = Date.now()
  await Database.use((db) => db.insert(RpaAppTable).values({ ...row, time_created: now, time_updated: now }))
}

export async function updateRpaApp(id: string, projectId: string, patch: Partial<NewRpaApp>) {
  await Database.use((db) =>
    db
      .update(RpaAppTable)
      .set({ ...patch, time_updated: Date.now() })
      .where(and(eq(RpaAppTable.id, id), eq(RpaAppTable.project_id, projectId))),
  )
}

export async function queryRpaApp(id: string) {
  const rows = await Database.use((db) => db.select().from(RpaAppTable).where(eq(RpaAppTable.id, id)).limit(1))
  return rows[0] ?? null
}

export async function queryRpaAppForProject(id: string, projectId: string) {
  const rows = await Database.use((db) =>
    db
      .select()
      .from(RpaAppTable)
      .where(and(eq(RpaAppTable.id, id), eq(RpaAppTable.project_id, projectId)))
      .limit(1),
  )
  return rows[0] ?? null
}

export async function queryRpaApps(projectId?: string) {
  if (projectId === undefined) {
    return Database.use((db) => db.select().from(RpaAppTable).orderBy(desc(RpaAppTable.time_created)))
  }
  return Database.use((db) =>
    db.select().from(RpaAppTable).where(eq(RpaAppTable.project_id, projectId)).orderBy(desc(RpaAppTable.time_created)),
  )
}

export async function deleteRpaApp(id: string, projectId: string) {
  await Database.use((db) =>
    db.delete(RpaAppTable).where(and(eq(RpaAppTable.id, id), eq(RpaAppTable.project_id, projectId))),
  )
}

export async function requireRpaApp(id: string) {
  return requireRow(await queryRpaApp(id), id, "rpa app")
}

export async function insertNextRpaVersion(row: Omit<NewRpaAppVersion, "version" | "time_created" | "time_updated">) {
  const now = Date.now()
  return Database.transaction(async (tx) => {
    if (Database.dialect === "pg") {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${row.app_id}))`)
    }
    const versions = await tx
      .select({ value: max(RpaAppVersionTable.version) })
      .from(RpaAppVersionTable)
      .where(eq(RpaAppVersionTable.app_id, row.app_id))
    const value = {
      ...row,
      version: (versions[0]?.value ?? 0) + 1,
      time_created: now,
      time_updated: now,
    }
    const inserted = await tx.insert(RpaAppVersionTable).values(value).returning()
    return requireRow(inserted[0], row.id, "rpa app version")
  })
}

export async function updateRpaVersion(id: string, patch: Partial<NewRpaAppVersion>) {
  await Database.use((db) =>
    db
      .update(RpaAppVersionTable)
      .set({ ...patch, time_updated: Date.now() })
      .where(eq(RpaAppVersionTable.id, id)),
  )
}

export async function queryRpaVersion(id: string) {
  const rows = await Database.use((db) =>
    db.select().from(RpaAppVersionTable).where(eq(RpaAppVersionTable.id, id)).limit(1),
  )
  return rows[0] ?? null
}

export async function requireRpaVersion(id: string) {
  return requireRow(await queryRpaVersion(id), id, "rpa app version")
}

export async function queryActiveRpaVersion(appId: string) {
  const rows = await Database.use((db) =>
    db
      .select()
      .from(RpaAppVersionTable)
      .where(and(eq(RpaAppVersionTable.app_id, appId), eq(RpaAppVersionTable.status, "active")))
      .limit(1),
  )
  return rows[0] ?? null
}

export async function queryRpaVersions(appId: string) {
  return Database.use((db) =>
    db
      .select()
      .from(RpaAppVersionTable)
      .where(eq(RpaAppVersionTable.app_id, appId))
      .orderBy(desc(RpaAppVersionTable.version)),
  )
}

/** app 级串行转正；expectedActiveId 防止陈旧修复覆盖更新的 active 版本。 */
export async function promoteRpaVersion(appId: string, versionId: string, expectedActiveId?: string) {
  return Database.transaction(async (tx: TxOrDb) => {
    if (Database.dialect === "pg") {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${appId}))`)
    }
    const targets = await tx
      .select({ id: RpaAppVersionTable.id })
      .from(RpaAppVersionTable)
      .where(and(eq(RpaAppVersionTable.id, versionId), eq(RpaAppVersionTable.app_id, appId)))
      .limit(1)
    requireRow(targets[0], versionId, "rpa app version")
    if (expectedActiveId !== undefined) {
      const active = await tx
        .select({ id: RpaAppVersionTable.id })
        .from(RpaAppVersionTable)
        .where(and(eq(RpaAppVersionTable.app_id, appId), eq(RpaAppVersionTable.status, "active")))
        .limit(1)
      if (active[0]?.id !== expectedActiveId) return false
    }
    const now = Date.now()
    await tx
      .update(RpaAppVersionTable)
      .set({ status: "retired", time_updated: now })
      .where(and(eq(RpaAppVersionTable.app_id, appId), eq(RpaAppVersionTable.status, "active")))
    const updated = await tx
      .update(RpaAppVersionTable)
      .set({ status: "active", time_updated: now })
      .where(and(eq(RpaAppVersionTable.id, versionId), eq(RpaAppVersionTable.app_id, appId)))
      .returning({ id: RpaAppVersionTable.id })
    return updated.length > 0
  })
}

export async function insertRpaRun(row: Omit<NewRpaAppRun, "time_created" | "time_updated">) {
  const now = Date.now()
  await Database.use((db) => db.insert(RpaAppRunTable).values({ ...row, time_created: now, time_updated: now }))
}

export async function updateRpaRun(id: string, patch: Partial<NewRpaAppRun>) {
  await Database.use((db) =>
    db
      .update(RpaAppRunTable)
      .set({ ...patch, time_updated: Date.now() })
      .where(eq(RpaAppRunTable.id, id)),
  )
}

export async function updateRpaRunIfStatus(id: string, status: RpaRunStatus, patch: Partial<NewRpaAppRun>) {
  const rows = await Database.use((db) =>
    db
      .update(RpaAppRunTable)
      .set({ ...patch, time_updated: Date.now() })
      .where(and(eq(RpaAppRunTable.id, id), eq(RpaAppRunTable.status, status)))
      .returning({ id: RpaAppRunTable.id }),
  )
  return rows.length > 0
}

export async function failActiveRpaRun(id: string, error: string, now = Date.now()) {
  const rows = await Database.use((db) =>
    db
      .update(RpaAppRunTable)
      .set({ status: "failed", error, time_finished: now, time_updated: now })
      .where(and(eq(RpaAppRunTable.id, id), inArray(RpaAppRunTable.status, ["pending", "running", "repairing"])))
      .returning({ id: RpaAppRunTable.id }),
  )
  return rows.length > 0
}

export async function queryRpaRun(id: string) {
  const rows = await Database.use((db) => db.select().from(RpaAppRunTable).where(eq(RpaAppRunTable.id, id)).limit(1))
  return rows[0] ?? null
}

export async function queryRpaRunForProject(id: string, projectId: string) {
  const rows = await Database.use((db) =>
    db
      .select()
      .from(RpaAppRunTable)
      .where(
        and(
          eq(RpaAppRunTable.id, id),
          inArray(
            RpaAppRunTable.app_id,
            db.select({ id: RpaAppTable.id }).from(RpaAppTable).where(eq(RpaAppTable.project_id, projectId)),
          ),
        ),
      )
      .limit(1),
  )
  return rows[0] ?? null
}

export async function requireRpaRun(id: string) {
  return requireRow(await queryRpaRun(id), id, "rpa run")
}

export async function queryRpaRuns(appId: string, limit = 50) {
  return Database.use((db) =>
    db
      .select()
      .from(RpaAppRunTable)
      .where(eq(RpaAppRunTable.app_id, appId))
      .orderBy(desc(RpaAppRunTable.time_created))
      .limit(limit),
  )
}

/** CAS 认领：仅 pending 可转 running，防并发重复触发。 */
export async function claimRpaRun(id: string, now = Date.now()) {
  const rows = await Database.use((db) =>
    db
      .update(RpaAppRunTable)
      .set({
        status: "running",
        time_started: sql`coalesce(${RpaAppRunTable.time_started}, ${now})`,
        time_updated: now,
      })
      .where(and(eq(RpaAppRunTable.id, id), eq(RpaAppRunTable.status, "pending")))
      .returning({ id: RpaAppRunTable.id }),
  )
  return rows.length > 0
}

/** 兜底清扫：实例死亡后无人写终态的 pending/running/repairing run。 */
export async function reapStaleRpaRuns(now = Date.now()) {
  try {
    const rows = await Database.use((db) =>
      db
        .update(RpaAppRunTable)
        .set({ status: "failed", error: "instance lost (stale rpa run)", time_finished: now, time_updated: now })
        .where(
          or(
            and(eq(RpaAppRunTable.status, "pending"), lt(RpaAppRunTable.time_created, now - STALE_RUN_MS)),
            and(
              inArray(RpaAppRunTable.status, ["running", "repairing"]),
              lt(RpaAppRunTable.time_started, now - STALE_RUN_MS),
            ),
          ),
        )
        .returning({ id: RpaAppRunTable.id }),
    )
    if (rows.length > 0) log.warn("reaped stale rpa runs", { count: rows.length })
    return rows.length
  } catch (error) {
    log.error("failed to reap stale rpa runs", { error: String(error) })
    return 0
  }
}

export * as RpaPG from "./rpa.pg"
