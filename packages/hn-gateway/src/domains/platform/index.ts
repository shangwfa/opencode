/**
 * /gw-api/apps、/gw-api/platform、/gw-api/private-info、/gw-api/nacos/* 路由。
 * 响应形态对齐原网关 AppController / AppsController（源码逐条核对）。
 */
import { Hono } from "hono"
import { appService, ConflictError, NotFoundError, type IPlatform } from "../apps/service.js"
import { pool } from "../../db/index.js"
import { logger } from "../../logger.js"
import { getGrayFeatureCacheStats } from "../ap/index.js"

export const platformApp = new Hono()

// 原 GET /gw-api/platform：返回聚合配置映射本体
platformApp.get("/platform", async (c) => c.json(await appService.getPlatform()))

// 原 GET /gw-api/platform/cached：缓存视图
platformApp.get("/platform/cached", async (c) => {
  const data = await appService.getPlatform()
  return c.json({ cached: true, data, isEmpty: !data || Object.keys(data).length === 0 })
})

// 原 GET /gw-api/private-info：平台级私有配置
platformApp.get("/private-info", async (c) => c.json(await appService.getConfig("private-info")))

// 原 GET /gw-api/nacos/subscribedConfigs（NacosConfigController）：已订阅配置列表
platformApp.get("/nacos/subscribedConfigs", async (c) => {
  return c.json([
    "apps(全量注册表)",
    ...Object.keys(appService.stats()),
    ...getGrayFeatureCacheStats().featureKeys.map((key) => `gray_features:${key}`),
  ])
})

// 原 GET /gw-api/nacos/status：状态查询（Nacos → PG + 缓存）
platformApp.get("/nacos/status", async (c) => {
  let dbUp = true
  try {
    await pool.query("SELECT 1")
  } catch {
    dbUp = false
  }
  return c.json({
    success: true,
    message: "Status retrieved successfully",
    data: { store: "postgres", db: dbUp ? "up" : "down", cache: appService.stats() },
  })
})

// 原 POST /gw-api/nacos/refresh：强制重读（清缓存后由下次读回源 PG）
platformApp.post("/nacos/refresh", async (c) => {
  appService.invalidateAll()
  const platform = await appService.getPlatform()
  return c.json({ success: true, message: "Config refreshed successfully", configCount: Object.keys(platform).length })
})

// 原 POST /gw-api/nacos/resubscribe：type=all|config|locale（locale 已裁剪，接受但按 config 处理）
platformApp.post("/nacos/resubscribe", async (c) => {
  const body = await c.req.json().catch(() => ({} as { type?: string }))
  const type = body?.type || "all"
  appService.invalidateAll()
  const platform = await appService.getPlatform()
  return c.json({
    success: true,
    message: "Resubscribe completed successfully",
    subscribedCount: Object.keys(platform).length,
    type: type === "locale" ? "config(已裁剪 locale)" : type,
  })
})

// 原 POST /gw-api/nacos/cache/fix：整份 IPlatform 修正（写穿 PG）
platformApp.post("/nacos/cache/fix", async (c) => {
  const config = (await c.req.json().catch(() => null)) as IPlatform | null
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return c.json({ success: false, message: "Invalid request body", error: "Config must be a valid JSON object" }, 400)
  }
  const configCount = await appService.fixPlatformCache(config)
  return c.json({ success: true, message: "Cache config fixed successfully", configCount })
})

// 原 POST /gw-api/nacos/app/:appId/update?mode=full|incremental（默认 incremental）
platformApp.post("/nacos/app/:appId/update", async (c) => {
  const appId = c.req.param("appId")
  const modeParam = c.req.query("mode")
  if (modeParam && modeParam !== "full" && modeParam !== "incremental") {
    return c.json({ success: false, message: "Invalid mode", error: "mode must be 'full' or 'incremental'" }, 400)
  }
  const mode = (modeParam || "incremental") as "full" | "incremental"
  const config = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  if (!config || typeof config !== "object") {
    return c.json({ success: false, message: "Invalid request body", error: "Config must be a valid JSON object" }, 400)
  }
  const versionHeader = c.req.header("x-expected-version")
  const expectedVersion = versionHeader ? Number(versionHeader) : undefined
  try {
    await appService.updateAppConfig(appId, mode, config, expectedVersion)
    return c.json({ success: true, message: "App config updated successfully", appId, mode })
  } catch (error) {
    if (error instanceof ConflictError) {
      return c.json({ success: false, message: error.message, error: "version_conflict" }, 409)
    }
    if (error instanceof NotFoundError) {
      return c.json({ success: false, message: error.message, error: "app_not_found" }, 404)
    }
    const message = error instanceof Error ? error.message : String(error)
    logger.error({ span: "nacos:app-update:error", msg: message })
    return c.json({ success: false, message: "Failed to update app config", error: message }, 500)
  }
})

// ── 原 app.controller 的灰度轮询运维路由（Nacos→PG 等价：预热=查库填缓存）──

// 原 GET /gw-api/backend-gray/polling/status
platformApp.get("/backend-gray/polling/status", async (c) => {
  const { getGrayFeatureCacheStats, warmAllGrayFeatures } = await import("../ap/index.js")
  await warmAllGrayFeatures()
  const stats = getGrayFeatureCacheStats()
  return c.json({
    success: true,
    message: "Polling status retrieved successfully",
    data: {
      totalFeatureKeys: stats.featureKeys.length,
      featureKeys: stats.featureKeys,
      details: stats.details,
      store: "postgres(ttl-cache)",
    },
  })
})

// 原 POST /gw-api/backend-gray/polling/start-all
platformApp.post("/backend-gray/polling/start-all", async (c) => {
  const { warmAllGrayFeatures } = await import("../ap/index.js")
  const platform = await appService.getPlatform()
  const started: Array<{ appId: string; featureKey: string }> = []
  const skipped: Array<{ appId: string; reason: string }> = []
  for (const [key, app] of Object.entries(platform)) {
    const backendGray = app.backendGray as { enabled?: boolean; featureKey?: string } | undefined
    if (backendGray?.enabled && backendGray.featureKey) {
      await warmAllGrayFeatures()
      started.push({ appId: String(app.appId), featureKey: backendGray.featureKey })
    } else {
      skipped.push({ appId: String(app.appId ?? key), reason: backendGray?.enabled ? "缺少 featureKey" : "backendGray 未启用" })
    }
  }
  return c.json({ success: true, message: "All polling started", data: { started, skipped } })
})

// 原 GET /gw-api/backend-gray/diagnose
platformApp.get("/backend-gray/diagnose", async (c) => {
  const { getGrayFeature, getGrayFeatureCacheStats } = await import("../ap/index.js")
  const platform = await appService.getPlatform()
  const diagnostics: Array<{ key: string; appId?: string; backendGray?: unknown; ruleExists: boolean; issue?: string }> = []
  for (const [key, app] of Object.entries(platform)) {
    const backendGray = app.backendGray as { enabled?: boolean; featureKey?: string; version?: string } | undefined
    if (!backendGray) continue
    if (!backendGray.enabled) {
      diagnostics.push({ key, appId: String(app.appId), backendGray, ruleExists: false, issue: "未启用" })
      continue
    }
    if (!backendGray.featureKey || !backendGray.version) {
      diagnostics.push({ key, appId: String(app.appId), backendGray, ruleExists: false, issue: "缺少 featureKey 或 version" })
      continue
    }
    const rule = await getGrayFeature(backendGray.featureKey)
    diagnostics.push({ key, appId: String(app.appId), backendGray, ruleExists: !!rule, issue: rule ? undefined : `灰度规则不存在: ${backendGray.featureKey}` })
  }
  const cache = getGrayFeatureCacheStats()
  return c.json({ success: true, data: { diagnostics, cache } })
})

// ── /gw-api/apps CRUD（发布/回滚在 ap 域）──

export const appsApp = new Hono()

// 原 GET /gw-api/apps：列表（原样返回平台映射）
appsApp.get("/", async (c) => c.json(await appService.getPlatform()))

// 原 POST /gw-api/apps/:appId：新建/更新（full upsert）
appsApp.post("/:appId", async (c) => {
  const appId = c.req.param("appId")
  const body = (await c.req.json().catch(() => null)) as
    | { domain?: string; baseRoute?: string; config?: Record<string, unknown>; enabled?: boolean }
    | null
  if (!body?.domain || !body.config || typeof body.config !== "object") {
    return c.json({ success: false, message: "domain 与 config 为必填" }, 400)
  }
  const result = await appService.upsertApp({
    appId,
    domain: body.domain,
    baseRoute: body.baseRoute ?? "",
    config: { appId, ...body.config },
    enabled: body.enabled,
  })
  return c.json({ success: true, message: "App saved", data: { appId, ...result } })
})

// 原 GET /gw-api/apps/domain/:domain：按域名列表
appsApp.get("/domain/:domain", async (c) => {
  const domain = c.req.param("domain").toLowerCase()
  const platform = await appService.getPlatform()
  const matched = Object.entries(platform).filter(([key]) => key === domain || key.startsWith(`${domain}/`))
  return c.json({ success: true, data: Object.fromEntries(matched) })
})

// 原 GET /gw-api/apps/:appId
appsApp.get("/:appId", async (c) => {
  const app = await appService.getAppByAppId(c.req.param("appId"))
  if (!app) return c.json({ success: false, message: "应用不存在" }, 404)
  return c.json({ success: true, data: app })
})

// 原 POST /gw-api/apps/project/:appId：建 GitLab 项目 + 初始化应用配置
appsApp.post("/project/:appId", async (c) => {
  const appId = c.req.param("appId")
  const body = (await c.req.json().catch(() => null)) as
    | (Record<string, unknown> & { namespace?: number; createType?: "create" | "exist"; appType?: string })
    | null
  if (!body) return c.json({ success: false, message: "Invalid body" }, 400)
  const { namespace, createType, appType, ...createAppDto } = body

  if (await appService.getAppByAppId(appId)) {
    return c.json({ success: false, message: `${appId} 应用已存在` }, 400)
  }
  const domain = String(createAppDto.domain ?? "").toLowerCase()
  const platform = await appService.getPlatform()
  const domainExists = Object.keys(platform).some((key) => key === domain || key.startsWith(`${domain}/`))
  if (domainExists) {
    return c.json({ success: false, message: `${domain} 域名已存在` }, 400)
  }

  const { createProject, npmCliForProject } = await import("../../integrations/gitlab-client.js")
  const response = await createProject({
    name: appId,
    namespace_id: Number(namespace),
    description: String(createAppDto.name ?? ""),
    createType: (createType as "create" | "exist") ?? "create",
  })

  if (createType === "create") {
    if (response) {
      await npmCliForProject({ appType: String(appType ?? ""), name: appId, gitlab: response })
    } else {
      return c.json({ success: false, message: `${appId} 应用已存在` }, 502)
    }
  } else if (!response) {
    return c.json({ success: false, message: `${appId} 应用不存在，请检查项目名是否与仓库一致` }, 502)
  }

  await appService.upsertApp({ appId, domain, baseRoute: "", config: { appId, ...createAppDto } })
  return c.json(response)
})

// 原 POST /gw-api/apps/publish/:appId：发布（写 version + publishList 置顶，保留 50 条）
appsApp.post("/publish/:appId", async (c) => {
  const appId = c.req.param("appId")
  const dto = (await c.req.json().catch(() => null)) as
    | { version?: string; commit?: string; commitMsg?: string; publisher?: string }
    | null
  if (!dto?.version) return c.json({ success: false, message: "version 为必填" }, 400)
  const app = await appService.getAppByAppId(appId)
  if (!app) return c.json({ success: false, message: "应用不存在" }, 400)

  const publishInfo = { time: new Date().toISOString().replace("T", " ").slice(0, 19), ...dto }
  const publishList = [publishInfo, ...(Array.isArray(app.publishList) ? (app.publishList as Record<string, unknown>[]) : [])].slice(0, 50)
  await appService.updateAppConfig(appId, "full", { ...app, version: dto.version, publishList })

  // 发布流水落库
  const { db, publishes } = await import("../../db/index.js")
  const id = `${appId}-${Date.now()}`
  await db.insert(publishes).values({
    id,
    appId,
    env: process.env["GATEWAY_ENV"] ?? "online",
    publishVersion: dto.version,
    status: "success",
    operator: dto.publisher ?? null,
    detail: { commit: dto.commit ?? "", commitMsg: dto.commitMsg ?? "" },
  })
  return c.text("success")
})

// 原 GET /gw-api/apps/publishList/:appId
appsApp.get("/publishList/:appId", async (c) => {
  const app = await appService.getAppByAppId(c.req.param("appId"))
  if (!app) return c.json({ success: false, message: "应用不存在" }, 404)
  return c.json((Array.isArray(app.publishList) ? app.publishList : []) as Record<string, unknown>[])
})
