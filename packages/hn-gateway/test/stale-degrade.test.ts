import { describe, expect, it, beforeAll, mock } from "bun:test"
import "./setup.js"

/**
 * PG 不可达时的降级逻辑（stale-while-error，原 Nacos 客户端断连快照语义）：
 * - 回源失败且有过期未超限（≤10min）缓存 → 返回旧值 + stale 日志
 * - 无缓存 / stale 超限 → 原样抛错
 * 用 mock.module 故障注入 db 抛错。
 */
describe("stale 降级（PG 不可达兜底）", () => {
  beforeAll(async () => {
    const { db, apps: appsTable, initGatewayDb } = await import("../src/db/index.js")
    await initGatewayDb()
    const { appService } = await import("../src/domains/apps/service.js")

    // 真实链路写入种子并预热三类缓存（正常 PG）
    await appService.upsertApp({ appId: "st_app", domain: "st.test", config: { version: "1.0.0" } })
    expect(await appService.getAppByDomain("st.test")).toMatchObject({ version: "1.0.0" })
    expect(await appService.getAppByAppId("st_app")).toMatchObject({ version: "1.0.0" })
    expect(await appService.getPlatform()).toMatchObject({ "st.test": { version: "1.0.0" } })

    // 记录原始 select 供说明（恢复由 bun test --isolate 的模块隔离保证）
    void db.select
    // 故障注入：db.select 一律抛 ECONNREFUSED（模拟 PG 不可达）
    mock.module("../src/db/index.js", () => ({
      db: new Proxy({}, { get: () => () => { throw new Error("ECONNREFUSED: simulated PG outage") } }),
      apps: appsTable,
      microApps: {},
      grayFeatures: {},
      configs: {},
      publishes: {},
      reportEvents: {},
      pool: {},
      schemaName: "hn_gateway_dev",
      initGatewayDb: async () => undefined,
    }))
  })

  it("PG 失败：getAppByDomain 降级返回过期缓存值", async () => {
    const { appService } = await import("../src/domains/apps/service.js")
    const value = await appService.getAppByDomain("st.test")
    expect(value).toMatchObject({ version: "1.0.0" })
  })

  it("PG 失败：getAppByAppId / getPlatform 同样降级", async () => {
    const { appService } = await import("../src/domains/apps/service.js")
    expect(await appService.getAppByAppId("st_app")).toMatchObject({ version: "1.0.0" })
    const platform = await appService.getPlatform()
    expect(platform["st.test"]).toMatchObject({ version: "1.0.0" })
  })

  it("PG 失败且无缓存（未预热过的 key）→ 原样抛错", async () => {
    const { appService } = await import("../src/domains/apps/service.js")
    expect(appService.getAppByDomain("never-warmed.test")).rejects.toThrow("ECONNREFUSED")
  })

  it("PG 失败且 stale 超限（>10min）→ 拒绝降级原样抛错", async () => {
    const { appService } = await import("../src/domains/apps/service.js")
    // 手动把缓存条目标记为 11 分钟前过期（模拟长期分区）
    const internal = appService as unknown as { byDomainRoute: Map<string, { value: unknown; expires: number }> }
    const entry = internal.byDomainRoute.get("st.test/")
    expect(entry).toBeTruthy()
    internal.byDomainRoute.set("st.test/", { ...entry!, expires: Date.now() - 11 * 60 * 1000 })
    expect(appService.getAppByDomain("st.test")).rejects.toThrow("ECONNREFUSED")
    // 超限后 hasAnyCachedApp 仍可看其它未超限条目（byAppId 预热过）
    expect(appService.hasAnyCachedApp()).toBe(true)
  })

  it("hasAnyCachedApp：有可用缓存 → true（health 降级依据）", async () => {
    const { appService } = await import("../src/domains/apps/service.js")
    expect(appService.hasAnyCachedApp()).toBe(true)
  })

  it("health：PG 不可达 + 缓存可用 → healthy(degraded)，不再 503", async () => {
    const { createGatewayApp } = await import("../src/app.js")
    const app = await createGatewayApp()
    const res = await app.fetch(new Request("http://localhost/health"))
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.status).toBe("healthy")
    expect(body.degraded).toBe(true)
    expect(body.db).toBe("down")
  })
})
