/**
 * /gw-api/ap：应用发布管理（原 ap.controller/ap.service 一比一迁移）。
 * - GET  /:id                        目标应用配置（固定 xybot-aipower-web；name 含 aipower/workos 时按 name）
 * - PATCH /:id                       全量更新应用配置
 * - GET  /version                    发布列表（当前版本置顶旋转）
 * - POST /rollback {version:number}  回滚（校验 publishList 含目标版本）
 * - POST /backend-gray               双模式：空对象=查询 backendGray；传参=合并写入 app.backendGray
 * - GET  /backend-gray/:featureKey   灰度规则查询（PG gray_features，等价原灰度规则服务）
 * - PUT  /backend-gray/feature/:featureKey  灰度规则写入（原为外部灰度服务管理，PG 化后由本路由承接）
 */
import { Hono } from "hono"
import { eq, sql } from "drizzle-orm"
import { appService } from "../apps/service.js"
import { db, grayFeatures } from "../../db/index.js"
import { logger } from "../../logger.js"

export const apApp = new Hono()

const TARGET_APP_ID = "xybot-aipower-web"

async function getTargetApp(name?: string): Promise<Record<string, unknown>> {
  const appId = name && (name.includes("aipower") || name.includes("workos")) ? name : TARGET_APP_ID
  const app = await appService.getAppByAppId(appId)
  if (!app) throw Object.assign(new Error("应用不存在"), { statusCode: 400 })
  return app
}

// ── 灰度规则（PG gray_features）──

export interface GrayFeatureRoute {
  featureKey: string
  config: Record<string, unknown>
}

const TTL_MS = 30_000
const cache = new Map<string, { config: Record<string, unknown> | null; expires: number }>()

/** 灰度缓存 PG 不可达时的降级上限（与 apps 一致） */
const STALE_MAX_MS = 10 * 60_000

export async function getGrayFeature(featureKey: string, refresh = false): Promise<Record<string, unknown> | null> {
  const cached = refresh ? undefined : cache.get(featureKey)
  if (cached && cached.expires > Date.now()) return cached.config
  try {
    const rows = await db
      .select({ config: grayFeatures.config })
      .from(grayFeatures)
      .where(eq(grayFeatures.featureKey, featureKey))
      .limit(1)
    const config = rows[0] ? (rows[0].config as Record<string, unknown>) : null
    cache.set(featureKey, { config, expires: Date.now() + TTL_MS })
    return config
  } catch (error) {
    // PG 不可达：降级用过期缓存（原 Nacos 客户端断连快照语义）
    const entry = cache.get(featureKey)
    if (entry && Date.now() - entry.expires <= STALE_MAX_MS) {
      logger.warn({ span: "cache:stale-degrade", msg: `PG 不可达，灰度规则降级使用过期缓存: ${featureKey}` })
      return entry.config
    }
    throw error
  }
}

export const grayInvalidation = {
  invalidate: (change: { table: string; key: string }) => {
    if (change.table === "gray_features") {
      if (change.key === "*") cache.clear()
      else cache.delete(change.key)
    }
  },
  invalidateAll: () => cache.clear(),
}

/** 轮询状态（原 poller.getPollingFeatureKeys/getPollingDetails 的 PG 等价信息） */
export function getGrayFeatureCacheStats(): {
  featureKeys: string[]
  details: Array<{ featureKey: string; cached: boolean; cachedAt: string | null; from: string }>
} {
  const now = Date.now()
  return {
    featureKeys: [...cache.keys()],
    details: [...cache.entries()].map(([featureKey, entry]) => ({
      featureKey,
      cached: entry.config !== null && entry.expires > now,
      cachedAt: entry.expires ? new Date(entry.expires - TTL_MS).toISOString() : null,
      from: "postgres",
    })),
  }
}

/** 预热全部灰度规则（原 start-all 轮询的 PG 等价动作） */
export async function warmAllGrayFeatures(): Promise<number> {
  const rows = await db.select({ featureKey: grayFeatures.featureKey }).from(grayFeatures)
  for (const row of rows) {
    cache.set(row.featureKey, { config: null, expires: 0 }) // 失效强制回源
    await getGrayFeature(row.featureKey)
  }
  return rows.length
}

// 灰度规则查询：配置 GATEWAY_GRAY_API_BASE_URL 时透传原外部灰度服务，否则读 PG（原 ap.getGrayFeatureRule 语义）
apApp.get("/backend-gray/:featureKey", async (c) => {
  const featureKey = c.req.param("featureKey")
  const externalBase = process.env["GATEWAY_GRAY_API_BASE_URL"]
  if (externalBase) {
    try {
      const res = await fetch(
        `${externalBase.replace(/\/$/, "")}/middleware/grayFeatureRoute/findFeatureRuleConfig?featureKey=${encodeURIComponent(featureKey)}`,
        { signal: AbortSignal.timeout(5_000) },
      )
      const rule = await res.json()
      if (!rule) return c.json({ success: false, message: `灰度规则不存在: featureKey=${featureKey}` }, 404)
      return c.json(rule)
    } catch (error) {
      logger.error({ span: "ap:gray-rule:external", msg: "外部灰度服务查询失败", error: String(error) })
      return c.json({ success: false, message: `灰度规则查询失败: ${String(error)}` }, 502)
    }
  }
  const config = await getGrayFeature(featureKey)
  if (!config) return c.json({ success: false, message: "灰度配置不存在" }, 404)
  return c.json({ success: true, data: config })
})

// 灰度规则写入（原为外部灰度服务的管理面，PG 化后由本路由承接）
apApp.put("/backend-gray/feature/:featureKey", async (c) => {
  const featureKey = c.req.param("featureKey")
  const config = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  if (!config || typeof config !== "object") {
    return c.json({ success: false, message: "config 为必填" }, 400)
  }
  const version = await db.transaction(async (tx) => {
    const result = await tx
      .insert(grayFeatures)
      .values({ featureKey, config })
      .onConflictDoUpdate({
        target: grayFeatures.featureKey,
        set: { config, version: sql`${grayFeatures.version} + 1`, updatedAt: new Date() },
      })
      .returning({ version: grayFeatures.version })
    await tx.execute(
      sql`SELECT pg_notify('gateway_config_changed', ${JSON.stringify({ table: "gray_features", key: featureKey })})`,
    )
    return result[0]!.version
  })
  cache.delete(featureKey)
  return c.json({ success: true, message: "Gray feature saved", data: { featureKey, version } })
})

// 双模式：查询/设置目标应用的 backendGray（原 POST /backend-gray 语义）
apApp.post("/backend-gray", async (c) => {
  const dto = (await c.req.json().catch(() => ({}))) as Record<string, unknown> | undefined
  const app = await getTargetApp()

  // 查询模式：空对象返回当前 backendGray
  if (!dto || Object.keys(dto).length === 0) {
    return c.json((app.backendGray as Record<string, unknown>) ?? {})
  }

  // 设置模式：合并写入
  const current = (app.backendGray as Record<string, unknown>) ?? {}
  const updated: Record<string, unknown> = {
    ...current,
    ...dto,
    ...(dto.version !== undefined && { version: String(dto.version) }),
  }
  await appService.updateAppConfig(TARGET_APP_ID, "incremental", { backendGray: updated })
  return c.json(updated)
})

// 发布列表（当前版本置顶旋转）
apApp.get("/version", async (c) => {
  const app = await getTargetApp()
  const publishList = (Array.isArray(app.publishList) ? app.publishList : []) as Record<string, unknown>[]
  const currentIndex = publishList.findIndex((item) => item.version === app.version)
  if (currentIndex <= 0) return c.json(publishList)
  return c.json([publishList[currentIndex], ...publishList.slice(0, currentIndex), ...publishList.slice(currentIndex + 1)])
})

// 回滚
apApp.post("/rollback", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { version?: number } | null
  if (typeof body?.version !== "number") return c.json({ success: false, message: "version 为必填数字" }, 400)
  const app = await getTargetApp()
  const publishList = (Array.isArray(app.publishList) ? app.publishList : []) as Record<string, unknown>[]
  if (publishList.length === 0) return c.json({ success: false, message: "无可回滚的版本" }, 400)
  const exists = publishList.some((item) => Number(item.version) === body.version)
  if (!exists) return c.json({ success: false, message: "目标版本不在发布历史中" }, 400)
  await appService.updateAppConfig(TARGET_APP_ID, "incremental", { version: `${body.version}` })
  return c.json({ success: true, message: `已成功回滚到版本 ${body.version}` })
})

// 目标应用配置
apApp.get("/:id", async (c) => {
  const app = await getTargetApp(c.req.param("id"))
  return c.json(app)
})

// 全量更新
apApp.patch("/:id", async (c) => {
  const dto = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  if (!dto?.appId) return c.json({ success: false, message: "appId 为必填" }, 400)
  const result = await appService.updateAppConfig(String(dto.appId), "full", dto)
  return c.json(result)
})
