import { describe, expect, it, beforeAll } from "bun:test"
import "./setup.js"
import { AppService, ConflictError, NotFoundError } from "../src/domains/apps/service.js"
import { initGatewayDb, pool, schemaName } from "../src/db/index.js"

async function cleanup(appIds: string[]) {
  for (const appId of appIds) {
    await pool.query(`DELETE FROM ${schemaName}.apps WHERE app_id = $1`, [appId])
  }
}

describe("AppService（P2 配置面）", () => {
  beforeAll(async () => {
    await initGatewayDb()
  })

  it("upsertApp full 写入 + getAppByDomain 精确匹配与根应用回退", async () => {
    const svc = new AppService()
    await svc.upsertApp({
      appId: "t-app-1",
      domain: "T1.Example.com",
      baseRoute: "sub",
      config: { appId: "t-app-1", url: "https://cos/sub", version: "1.0.0" },
    })
    await svc.upsertApp({
      appId: "t-app-root",
      domain: "t1.example.com",
      baseRoute: "",
      config: { appId: "t-app-root", url: "https://cos/root", version: "2.0.0" },
    })

    // 精确匹配
    expect(await svc.getAppByDomain("t1.example.com", "sub")).toMatchObject({ appId: "t-app-1", version: "1.0.0" })
    // 根应用回退（原 config[domain] 语义）
    expect(await svc.getAppByDomain("t1.example.com", "other")).toMatchObject({ appId: "t-app-root" })
    await cleanup(["t-app-1", "t-app-root"])
  })

  it("getPlatform 聚合映射：domain/baseRoute 与 domain 两种 key", async () => {
    const svc = new AppService()
    await svc.upsertApp({ appId: "t-map-1", domain: "map.com", baseRoute: "sub", config: { a: 1 } })
    await svc.upsertApp({ appId: "t-map-2", domain: "map.com", baseRoute: "", config: { b: 2 } })
    const platform = await svc.getPlatform()
    expect(platform["map.com/sub"]).toMatchObject({ appId: "t-map-1" })
    expect(platform["map.com"]).toMatchObject({ appId: "t-map-2" })
    await cleanup(["t-map-1", "t-map-2"])
  })

  it("updateAppConfig incremental 为 JSONB 合并、full 为整体替换", async () => {
    const svc = new AppService()
    await svc.upsertApp({
      appId: "t-inc",
      domain: "inc.com",
      config: { appId: "t-inc", url: "https://cos/inc", version: "1.0.0", keepMe: true },
    })
    const merged = await svc.updateAppConfig("t-inc", "incremental", { version: "1.1.0", extra: "x" })
    expect(merged.version).toBe(2)
    expect(merged.config).toMatchObject({ url: "https://cos/inc", version: "1.1.0", keepMe: true, extra: "x" })

    const replaced = await svc.updateAppConfig("t-inc", "full", { appId: "t-inc", only: "this" })
    expect(replaced.config).toEqual({ appId: "t-inc", only: "this" })
    expect(replaced.version).toBe(3)
    await cleanup(["t-inc"])
  })

  it("乐观锁：expectedVersion 不匹配抛 ConflictError；应用不存在抛 NotFoundError", async () => {
    const svc = new AppService()
    await svc.upsertApp({ appId: "t-lock", domain: "lock.com", config: { v: 1 } })
    expect(svc.updateAppConfig("t-lock", "incremental", { v: 2 }, 99)).rejects.toBeInstanceOf(ConflictError)
    expect(svc.updateAppConfig("no-such-app", "full", { v: 1 })).rejects.toBeInstanceOf(NotFoundError)
    // 正确版本可更新
    const ok = await svc.updateAppConfig("t-lock", "incremental", { v: 2 }, 1)
    expect(ok.version).toBe(2)
    await cleanup(["t-lock"])
  })

  it("写后本地缓存同步失效（对齐原 Nacos 自发布自回调）", async () => {
    const svc = new AppService()
    await svc.upsertApp({ appId: "t-cache", domain: "cache.com", config: { version: "1.0.0" } })
    expect(await svc.getAppByDomain("cache.com")).toMatchObject({ version: "1.0.0" })
    // 命中缓存后更新，立即读应拿到新值而非缓存旧值
    await svc.updateAppConfig("t-cache", "incremental", { version: "1.0.1" })
    expect(await svc.getAppByDomain("cache.com")).toMatchObject({ version: "1.0.1" })
    await cleanup(["t-cache"])
  })

  it("fixPlatformCache 批量写穿", async () => {
    const svc = new AppService()
    const count = await svc.fixPlatformCache({
      "fix.com/sub": { appId: "t-fix-1", url: "u1" },
      "fix.com": { appId: "t-fix-2", url: "u2" },
      "bad-entry": { url: "no-appid" },
    })
    expect(count).toBe(2)
    expect(await svc.getAppByDomain("fix.com", "sub")).toMatchObject({ appId: "t-fix-1" })
    await cleanup(["t-fix-1", "t-fix-2"])
  })
})
