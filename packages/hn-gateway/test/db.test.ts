import { describe, expect, it, beforeAll } from "bun:test"
import "./setup.js"

describe("db schema 初始化", () => {
  beforeAll(async () => {
    const { initGatewayDb } = await import("../src/db/index.js")
    await initGatewayDb()
  })

  it("schema 与全部表幂等创建，且可插入/查询 configs", async () => {
    const { pool, schemaName } = await import("../src/db/index.js")

    // 重复执行确保幂等
    const { ensureGatewayTables } = await import("../src/db/ensure-schema.js")
    await ensureGatewayTables(pool, schemaName)

    const insert = await pool.query(
      `INSERT INTO ${schemaName}.configs (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()
       RETURNING version`,
      ["__test_key__", { hello: "world" }],
    )
    expect(insert.rows[0]!.version).toBe(1)

    const select = await pool.query(`SELECT value FROM ${schemaName}.configs WHERE key = $1`, ["__test_key__"])
    expect(select.rows[0]!.value).toEqual({ hello: "world" })

    await pool.query(`DELETE FROM ${schemaName}.configs WHERE key = $1`, ["__test_key__"])
  })

  it("apps 表：domain+base_route 唯一约束生效", async () => {
    const { pool, schemaName } = await import("../src/db/index.js")
    const config = { appId: "app-a", url: "https://cos.example.com/static/app-a", version: "1.0.0" }

    await pool.query(
      `INSERT INTO ${schemaName}.apps (app_id, domain, base_route, config) VALUES ($1,$2,$3,$4)
       ON CONFLICT (app_id) DO UPDATE SET config = $4`,
      ["app-a", "test.example.com", "", config],
    )
    // 同 app_id 二次写入走 upsert 不报错
    await expect(
      pool.query(
        `INSERT INTO ${schemaName}.apps (app_id, domain, base_route, config) VALUES ($1,$2,$3,$4)`,
        ["app-a", "test.example.com", "", config],
      ),
    ).rejects.toThrow()
    // domain+base_route 冲突同样拒绝
    await expect(
      pool.query(
        `INSERT INTO ${schemaName}.apps (app_id, domain, base_route, config) VALUES ($1,$2,$3,$4)`,
        ["app-b", "test.example.com", "", config],
      ),
    ).rejects.toThrow()

    await pool.query(`DELETE FROM ${schemaName}.apps WHERE app_id IN ($1,$2)`, ["app-a", "app-b"])
  })

  it("micro_apps 表：默认值与 upsert", async () => {
    const { pool, schemaName } = await import("../src/db/index.js")
    await pool.query(
      `INSERT INTO ${schemaName}.micro_apps (app_id, name, baseroute, url) VALUES ($1,$2,$3,$4)
       ON CONFLICT (app_id) DO UPDATE SET url = $4`,
      ["sub-app-1", "子应用1", "/sub", "https://cos.example.com/static/sub-app-1"],
    )
    const row = await pool.query(`SELECT iframe, destroy, enabled, row_version FROM ${schemaName}.micro_apps WHERE app_id = $1`, ["sub-app-1"])
    expect(row.rows[0]!.iframe).toBe(false)
    expect(row.rows[0]!.destroy).toBe(false)
    expect(row.rows[0]!.enabled).toBe(true)
    await pool.query(`DELETE FROM ${schemaName}.micro_apps WHERE app_id = $1`, ["sub-app-1"])
  })
})
