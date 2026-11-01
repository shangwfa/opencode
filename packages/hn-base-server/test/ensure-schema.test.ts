import { describe, expect, test } from "bun:test"
import { ensureSchema } from "../src/db/ensure-schema"

/**
 * 多 Pod 同时启动会并发执行同一批 DDL；PostgreSQL 里两条 ALTER TABLE 会互相等待
 * AccessExclusiveLock 而死锁（实测 40P01 直接让进程退出）。串行化后必须全部成功。
 */
describe("ensureSchema 并发启动", () => {
  test("5 个实例同时建表不死锁", async () => {
    const { Pool } = await import("pg")
    const pool = new Pool({ connectionString: process.env.BASE_DATABASE_URL ?? "postgres://postgres:ab123456@127.0.0.1:5432/opencode-v2-up", max: 8 })
    const schema = `hn_ensure_race_${Date.now()}`
    try {
      const results = await Promise.allSettled(Array.from({ length: 5 }, () => ensureSchema(pool, schema)))
      const failed = results.filter((item) => item.status === "rejected") as PromiseRejectedResult[]
      expect(failed.map((item) => String(item.reason))).toEqual([])
      const tables = await pool.query(
        `select table_name from information_schema.tables where table_schema=$1 and table_name in ('automation_app','automation_run','browser_session') order by 1`,
        [schema],
      )
      expect(tables.rows.map((row: { table_name: string }) => row.table_name)).toEqual([
        "automation_app",
        "automation_run",
        "browser_session",
      ])
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await pool.end()
    }
  }, 120_000)
})
