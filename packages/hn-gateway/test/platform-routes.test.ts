import { describe, expect, it, beforeAll } from "bun:test"
import "./setup.js"

/**
 * P2 管理面路由 e2e：app.fetch 直调，断言 HTTP 结果与 PG 落库。
 */
describe("/gw-api 管理面路由", () => {
  let app: any

  beforeAll(async () => {
    const { initGatewayDb } = await import("../src/db/index.js")
    await initGatewayDb()
    const { createGatewayApp } = await import("../src/app.js")
    app = await createGatewayApp()
  })

  async function cleanup(appIds: string[]) {
    const { pool, schemaName } = await import("../src/db/index.js")
    for (const appId of appIds) {
      await pool.query(`DELETE FROM ${schemaName}.apps WHERE app_id = $1`, [appId])
      await pool.query(`DELETE FROM ${schemaName}.micro_apps WHERE app_id = $1`, [appId])
      await pool.query(`DELETE FROM ${schemaName}.gray_features WHERE feature_key = $1`, [appId])
    }
    await pool.query(`DELETE FROM ${schemaName}.configs WHERE key = 'private-info'`)
  }

  it("POST /gw-api/apps/:appId 建 → GET /gw-api/platform 可查 → GET /:appId 可查", async () => {
    await cleanup(["rt-app-1"])
    const create = await app.fetch(
      new Request("http://localhost/gw-api/apps/rt-app-1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ domain: "rt.com", baseRoute: "web", config: { url: "https://cos/rt", version: "1.0.0" } }),
      }),
    )
    expect(create.status).toBe(200)
    expect(((await create.json()) as any).data.data.version).toBe(1)

    const platform = ((await (await app.fetch(new Request("http://localhost/gw-api/platform"))).json()) as any).data as Record<string, any>
    expect(platform["rt.com/web"]).toMatchObject({ appId: "rt-app-1", url: "https://cos/rt" })

    const byId = await app.fetch(new Request("http://localhost/gw-api/apps/rt-app-1"))
    expect(((await byId.json()) as any).data.data.url).toBe("https://cos/rt")

    const byDomain = await app.fetch(new Request("http://localhost/gw-api/apps/domain/rt.com"))
    expect(Object.keys(((await byDomain.json()) as any).data.data)).toContain("rt.com/web")

    // PG 落库断言
    const { pool, schemaName } = await import("../src/db/index.js")
    const row = await pool.query(`SELECT domain, base_route, version FROM ${schemaName}.apps WHERE app_id = $1`, ["rt-app-1"])
    expect(row.rows[0]).toMatchObject({ domain: "rt.com", base_route: "web", version: 1 })
    await cleanup(["rt-app-1"])
  })

  it("POST /gw-api/nacos/app/:appId/update?mode=incremental 合并生效", async () => {
    await cleanup(["rt-inc"])
    await app.fetch(
      new Request("http://localhost/gw-api/apps/rt-inc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ domain: "rt2.com", config: { url: "u", version: "1.0.0" } }),
      }),
    )
    const res = await app.fetch(
      new Request("http://localhost/gw-api/nacos/app/rt-inc/update?mode=incremental", {
        method: "POST",
        headers: { "content-type": "application/json", "x-expected-version": "1" },
        body: JSON.stringify({ version: "1.2.0" }),
      }),
    )
    const body = (await res.json()) as any
    expect(body.data.success).toBe(true)
    expect(body.data.message).toBe("App config updated successfully")
    expect(body.data.mode).toBe("incremental")

    // 版本冲突 409
    const conflict = await app.fetch(
      new Request("http://localhost/gw-api/nacos/app/rt-inc/update?mode=incremental", {
        method: "POST",
        headers: { "content-type": "application/json", "x-expected-version": "1" },
        body: JSON.stringify({ version: "9" }),
      }),
    )
    expect(conflict.status).toBe(409)
    await cleanup(["rt-inc"])
  })

  it("POST /gw-api/nacos/cache/fix 整份修正 + /nacos/status + /refresh", async () => {
    const fix = await app.fetch(
      new Request("http://localhost/gw-api/nacos/cache/fix", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ "fixrt.com": { appId: "rt-fix", url: "u" } }),
      }),
    )
    expect(((await fix.json()) as any).data.configCount).toBe(1)

    const status = await app.fetch(new Request("http://localhost/gw-api/nacos/status"))
    const statusBody = (await status.json()) as any
    expect(statusBody.data.success).toBe(true)
    expect(statusBody.data.data.store).toBe("postgres")
    expect(statusBody.data.data.db).toBe("up")

    const refresh = await app.fetch(new Request("http://localhost/gw-api/nacos/refresh", { method: "POST" }))
    expect(((await refresh.json()) as any).data.success).toBe(true)
    await cleanup(["rt-fix"])
  })

  it("private-info：服务写入后 /gw-api/private-info 可读", async () => {
    const { appService } = await import("../src/domains/apps/service.js")
    await appService.putConfig("private-info", { secret: "s1" })
    const res = await app.fetch(new Request("http://localhost/gw-api/private-info"))
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).data).toMatchObject({ secret: "s1" })
    const { pool, schemaName } = await import("../src/db/index.js")
    await pool.query(`DELETE FROM ${schemaName}.configs WHERE key = 'private-info'`)
  })

  it("/gw-api/microapps CRUD", async () => {
    await cleanup(["rt-micro"])
    const create = await app.fetch(
      new Request("http://localhost/gw-api/microapps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appId: "rt-micro", name: "子应用", baseroute: "/sub", url: "https://cos/micro" }),
      }),
    )
    expect(create.status).toBe(200)

    const list = (await (await app.fetch(new Request("http://localhost/gw-api/microapps"))).json()) as any
    expect(list.data as string[]).toContain("rt-micro")

    const one = await app.fetch(new Request("http://localhost/gw-api/microapps/rt-micro"))
    expect(((await one.json()) as any).data.url).toBe("https://winrobot-pub-a-cos.yingdao.com/static/rt-micro/online")

    const update = await app.fetch(
      new Request("http://localhost/gw-api/microapps/rt-micro", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "改名" }),
      }),
    )
    expect(((await update.json()) as any).data).toContain("This action updates a #rt-micro microapp")
    await cleanup(["rt-micro"])
  })

  it("/gw-api/ap/backend-gray：规则写入与查询", async () => {
    await cleanup(["feat-rt"])
    const save = await app.fetch(
      new Request("http://localhost/gw-api/ap/backend-gray/feature/feat-rt", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ percent: 10, backend: "gray-host" }),
      }),
    )
    expect(save.status).toBe(200)
    const get = await app.fetch(new Request("http://localhost/gw-api/ap/backend-gray/feat-rt"))
    expect(((await get.json()) as any).data.data).toMatchObject({ percent: 10 })
    await cleanup(["feat-rt"])
  })
})
