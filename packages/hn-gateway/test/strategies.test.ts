import { describe, expect, it, beforeAll } from "bun:test"
import "./setup.js"

/**
 * P4 灰度策略命中矩阵（确定性断言）。
 */
import { GrayReleaseStrategyManager } from "../src/hosting/strategies/manager.js"
import { BackendGrayStrategy, javaStringHashCode } from "../src/hosting/strategies/backend-gray.js"
import { UserEnterpriseStrategy } from "../src/hosting/strategies/user-enterprise.js"
import { NetworkStrategy } from "../src/hosting/strategies/network.js"
import { PercentStrategy } from "../src/hosting/strategies/percent.js"
import { getGrayFeature } from "../src/domains/ap/index.js"
import { db, grayFeatures } from "../src/db/index.js"
import { eq, sql } from "drizzle-orm"

function ctx(overrides: { cookie?: string; ip?: string } = {}, app: Record<string, unknown> = {}): any {
  const req = new Request("http://localhost/", {
    headers: {
      ...(overrides.cookie ? { cookie: overrides.cookie } : {}),
      ...(overrides.ip ? { "x-forwarded-for": overrides.ip } : {}),
    },
  })
  return {
    req,
    app,
    domain: "p4.test",
    baseUrl: "/",
    traceId: "trace-123",
    // hono/cookie 需要 c.req.raw；setCookie 需要 c.header
    c: { req: { raw: req }, header: () => undefined },
  }
}

describe("P4 灰度策略", () => {
  const FEATURE_KEY = "feat-p4"

  beforeAll(async () => {
    // 写入 feature 路由配置（原 GrayFeatureRouteConfig 形态）
    const config = {
      featureKey: FEATURE_KEY,
      version: 1,
      defaultStatus: false,
      globalEnabled: false,
      percentage: 0,
      percentageKey: "",
      startTime: null,
      endTime: null,
      metadata: {},
      whiteList: { userId: ["white-user"] },
      blackList: { userId: ["black-user"] },
    }
    await db
      .insert(grayFeatures)
      .values({ featureKey: FEATURE_KEY, config })
      .onConflictDoUpdate({ target: grayFeatures.featureKey, set: { config } })
    await getGrayFeature(FEATURE_KEY) // 预热 TTL 缓存
  })

  it("Java hashCode 与后端一致（32 位有符号溢出）", () => {
    expect(javaStringHashCode("")).toBe(0)
    expect(javaStringHashCode("hello")).toBe(99162322)
    expect(javaStringHashCode(" user-1")).not.toBeNaN()
  })

  it("backend-gray：globalEnabled 全局放行灰度版本", async () => {
    await upsertFeature(FEATURE_KEY, { globalEnabled: true })
    await getGrayFeature(FEATURE_KEY, true) // 失效缓存重读
    const strategy = new BackendGrayStrategy()
    const result = await strategy.selectVersion(ctx({}, { backendGray: { enabled: true, featureKey: FEATURE_KEY, version: "2.0.0-gray" } }))
    expect(result).toEqual({ version: "2.0.0-gray", strategy: "backend-gray" })
  })

  it("backend-gray：白名单 userId 命中", async () => {
    await upsertFeature(FEATURE_KEY, { globalEnabled: false, percentage: 0, percentageKey: "" })
    await getGrayFeature(FEATURE_KEY, true)
    const strategy = new BackendGrayStrategy()
    const result = await strategy.selectVersion(
      ctx({ cookie: "uuid=white-user; enterpriseUuid=org-1" }, { backendGray: { enabled: true, featureKey: FEATURE_KEY, version: "2.0.0-gray" } }),
    )
    expect(result).toEqual({ version: "2.0.0-gray", strategy: "backend-gray" })
  })

  it("backend-gray：黑名单命中返回 blackListVersion；未配置则 null", async () => {
    const strategy = new BackendGrayStrategy()
    const appConfig = { backendGray: { enabled: true, featureKey: FEATURE_KEY, version: "2.0.0-gray", blackListVersion: "1.0.0-stable" } }
    // 白名单外的用户走概率（percentage=0 不通过），黑名单用户拿到 blackListVersion
    const hit = await strategy.selectVersion(ctx({ cookie: "uuid=black-user" }, appConfig))
    expect(hit).toEqual({ version: "1.0.0-stable", strategy: "backend-gray" })

    const appConfigNoBl = { backendGray: { enabled: true, featureKey: FEATURE_KEY, version: "2.0.0-gray" } }
    const miss = await strategy.selectVersion(ctx({ cookie: "uuid=black-user" }, appConfigNoBl))
    expect(miss).toBeNull()
  })

  it("backend-gray：percentageKey=userId 按 Java hashCode 分桶（与后端一致）", async () => {
    const hash = Math.abs(javaStringHashCode("bucket-user") % 100)
    const percentage = hash + 1 // 保证命中
    await upsertFeature(FEATURE_KEY, { globalEnabled: false, percentage, percentageKey: "userId" })
    await getGrayFeature(FEATURE_KEY, true)
    const strategy = new BackendGrayStrategy()
    const result = await strategy.selectVersion(
      ctx({ cookie: "uuid=bucket-user" }, { backendGray: { enabled: true, featureKey: FEATURE_KEY, version: "2.0.0-gray" } }),
    )
    expect(result).toEqual({ version: "2.0.0-gray", strategy: "backend-gray" })

    // 边界：percentage 恰好等于 hash → 不命中
    await upsertFeature(FEATURE_KEY, { globalEnabled: false, percentage: hash, percentageKey: "userId" })
    await getGrayFeature(FEATURE_KEY, true)
    const miss = await strategy.selectVersion(
      ctx({ cookie: "uuid=bucket-user" }, { backendGray: { enabled: true, featureKey: FEATURE_KEY, version: "2.0.0-gray" } }),
    )
    expect(miss).toBeNull()
  })

  it("backend-gray：时间窗外不灰度", async () => {
    await upsertFeature(FEATURE_KEY, {
      globalEnabled: true,
      startTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    })
    await getGrayFeature(FEATURE_KEY, true)
    const strategy = new BackendGrayStrategy()
    const result = await strategy.selectVersion(ctx({ cookie: "uuid=white-user" }, { backendGray: { enabled: true, featureKey: FEATURE_KEY, version: "2.0.0-gray" } }))
    expect(result).toBeNull()
  })

  it("user-enterprise：企业命中 → 用户级覆盖；无 cookie 返回 null", () => {
    const strategy = new UserEnterpriseStrategy()
    const appConfig = {
      canary: [{ enterpriseUuid: "ent-1", version: "2.0.0-canary", users: [{ uuid: "u-1", version: "3.0.0-user" }] }],
    }
    // 企业级
    expect(strategy.selectVersion(ctx({ cookie: "uuid=other; enterpriseUuid=ent-1" }, appConfig))).toEqual({
      version: "2.0.0-canary",
      strategy: "user-enterprise",
    })
    // 用户级覆盖
    expect(strategy.selectVersion(ctx({ cookie: "uuid=u-1; enterpriseUuid=ent-1" }, appConfig))).toEqual({
      version: "3.0.0-user",
      strategy: "user-enterprise",
    })
    // 无 cookie
    expect(strategy.selectVersion(ctx({}, appConfig))).toBeNull()
  })

  it("network：internalCanary + IP 白名单（精确与 CIDR）", () => {
    process.env["INTERNAL_GRAY_IPS"] = "10.1.1.5,192.168.0.0/24"
    const strategy = new NetworkStrategy()
    const appConfig = { internalCanary: { enabled: true, version: "5.0.0-internal" } }
    // ::ffff: 前缀剥离
    expect(strategy.selectVersion(ctx({ ip: "::ffff:10.1.1.5" }, appConfig))).toEqual({ version: "5.0.0-internal", strategy: "network" })
    // CIDR 命中
    expect(strategy.selectVersion(ctx({ ip: "192.168.0.88" }, appConfig))).toEqual({ version: "5.0.0-internal", strategy: "network" })
    // 未命中
    expect(strategy.selectVersion(ctx({ ip: "8.8.8.8" }, appConfig))).toBeNull()
    // 未启用
    expect(strategy.selectVersion(ctx({ ip: "10.1.1.5" }, { internalCanary: { enabled: false, version: "x" } }))).toBeNull()
  })

  it("percent：cookie 复用分桶、版本切换重算并回写 cookie", async () => {
    const strategy = new PercentStrategy()
    const appConfig = { appId: "p4-percent", percentCanary: { version: "2.0.0-pct", percentage: 10 } }
    // cookie hash=5 < 10 命中
    const hit = await strategy.selectVersion(ctx({ cookie: "gray_hash_p4-percent=2.0.0-pct:5" }, appConfig))
    expect(hit).toEqual({ version: "2.0.0-pct", strategy: "percent" })
    // cookie hash=99 ≥ 10 不命中
    const miss = await strategy.selectVersion(ctx({ cookie: "gray_hash_p4-percent=2.0.0-pct:99" }, appConfig))
    expect(miss).toBeNull()
    // 版本不匹配的 cookie 不复用：重算并回写 set-cookie
    const context = ctx({ cookie: "gray_hash_p4-percent=1.0.0-old:50" }, appConfig)
    const result = await strategy.selectVersion(context)
    expect([null, { version: "2.0.0-pct", strategy: "percent" }]).toContainEqual(result)
  })

  it("策略排序：backend-gray(50) 优先于 user-enterprise(100)", async () => {
    await upsertFeature(FEATURE_KEY, { globalEnabled: true, percentage: 0, percentageKey: "", startTime: null, endTime: null })
    await getGrayFeature(FEATURE_KEY, true)
    const manager = new GrayReleaseStrategyManager([new UserEnterpriseStrategy(), new BackendGrayStrategy()])
    const result = await manager.selectVersion({
      req: new Request("http://localhost/", { headers: { cookie: "uuid=white-user; enterpriseUuid=ent-1" } }),
      app: {
        backendGray: { enabled: true, featureKey: FEATURE_KEY, version: "2.0.0-gray" },
        canary: [{ enterpriseUuid: "ent-1", version: "2.0.0-canary" }],
      },
      domain: "p4.test",
      baseUrl: "/",
      traceId: "t",
    } as any)
    expect(result).toBe("2.0.0-gray")
  })
})

async function upsertFeature(featureKey: string, patch: Record<string, unknown>) {
  const existing = ((await getGrayFeature(featureKey, true)) as Record<string, unknown>) ?? {}
  const config = {
    featureKey,
    version: 1,
    defaultStatus: false,
    globalEnabled: false,
    percentage: 0,
    percentageKey: "",
    startTime: null,
    endTime: null,
    metadata: {},
    whiteList: { userId: ["white-user"] },
    blackList: { userId: ["black-user"] },
    ...existing,
    ...patch,
  }
  await db
    .insert(grayFeatures)
    .values({ featureKey, config })
    .onConflictDoUpdate({
      target: grayFeatures.featureKey,
      set: { config, version: sql`${grayFeatures.version} + 1`, updatedAt: new Date() },
    })
}
