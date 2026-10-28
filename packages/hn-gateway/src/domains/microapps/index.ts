/**
 * /gw-api/microapps：微前端子应用发布（原 microapps.service 一比一迁移）。
 *
 * 原语义（基于 Nacos 多 dataId）→ PG 映射：
 * - per-app dataId（微应用自身配置：name/appId/owner/gitLab/createTime/publishList）→ micro_apps 表
 * - micro_app_list（appId 字符串数组，新的在前）→ 查询时按 updated_at 倒序聚合（等价"新发布在前"）
 * - 宿主 app 的 config.microApps 数组（HTML 注入源）→ apps 表 config 内，发布时同步 upsert
 *
 * publish 双路径（原实现）：
 * - 微应用已有配置：追加 publishList（time/publisher/url/commit/commitMsg/version）
 * - 新微应用：初始化配置 + publishList[0]
 * - 两者都会：若 mainAppId 存在 → 宿主 microApps upsert（url/version/createTime/publisher/commit）
 * url = PUBLIC_PATH/{appId}（fullStack）或 PUBLIC_PATH/{appId}/{env||'online'}
 */
import { Hono } from "hono"
import { desc, eq, sql } from "drizzle-orm"
import { db, microApps } from "../../db/index.js"
import { appService } from "../apps/service.js"
import { logger } from "../../logger.js"

export interface MicroAppConfig {
  name: string
  appId: string
  owner?: string
  gitLab?: string
  createTime?: string
  publishList?: Array<Record<string, unknown>>
  [key: string]: unknown
}

function publicPath(): string {
  return (process.env["GATEWAY_STATIC_PUBLIC_PATH"] || "https://winrobot-pub-a-cos.yingdao.com/static").replace(/\/$/, "")
}

function now(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function buildUrl(dto: { appId: string; fullStack?: boolean; env?: string }): string {
  return dto.fullStack ? `${publicPath()}/${dto.appId}` : `${publicPath()}/${dto.appId}/${dto.env || "online"}`
}

const TTL_MS = 30_000
const STALE_MAX_MS = 10 * 60_000
let listCache: { value: string[]; expires: number } | null = null

/** 原 findAll：micro_app_list（appId 数组，新发布在前） */
async function listMicroApps(): Promise<string[]> {
  if (listCache && listCache.expires > Date.now()) return listCache.value
  try {
    const rows = await db.select({ appId: microApps.appId }).from(microApps).orderBy(desc(microApps.updatedAt))
    const value = rows.map((row) => row.appId)
    listCache = { value, expires: Date.now() + TTL_MS }
    return value
  } catch (error) {
    // PG 不可达：降级用过期列表
    if (listCache && Date.now() - listCache.expires <= STALE_MAX_MS) {
      logger.warn({ span: "cache:stale-degrade", msg: "PG 不可达，微前端列表降级使用过期缓存" })
      return listCache.value
    }
    throw error
  }
}

function invalidateList(_change?: { table: string; key: string }): void {
  listCache = null
}

export const microappsInvalidation = { invalidate: invalidateList, invalidateAll: invalidateList }

export const microappsApp = new Hono()

// 原 GET /gw-api/microapps：appId 列表
microappsApp.get("/", async (c) => c.json(await listMicroApps()))

// 原 GET /gw-api/microapps/:appId：微应用自身配置
microappsApp.get("/:appId", async (c) => {
  const rows = await db.select().from(microApps).where(eq(microApps.appId, c.req.param("appId"))).limit(1)
  if (!rows[0]) return c.json(null)
  const row = rows[0]
  return c.json({
    name: row.name,
    appId: row.appId,
    baseroute: row.baseroute,
    url: row.url,
    owner: (row.config as Record<string, unknown>)?.owner,
    gitLab: (row.config as Record<string, unknown>)?.gitLab,
    createTime: (row.config as Record<string, unknown>)?.createTime,
    publishList: (row.config as Record<string, unknown>)?.publishList ?? [],
    version: row.microVersion,
  })
})

// 原 POST /gw-api/microapps：发布（双路径）
microappsApp.post("/", async (c) => {
  const dto = (await c.req.json().catch(() => null)) as
    | (MicroAppConfig & { mainAppId?: string; fullStack?: boolean; env?: string; version?: string; commit?: string; commitMsg?: string })
    | null
  if (!dto?.appId || !dto.name) {
    return c.json({ success: false, message: "appId 与 name 为必填" }, 400)
  }
  const url = buildUrl(dto)
  const time = now()
  const publishEntry = {
    time,
    publisher: dto.owner ?? "",
    url,
    commit: dto.commit ?? "",
    commitMsg: dto.commitMsg ?? "",
    version: dto.version ?? "",
  }

  const existing = await db.select().from(microApps).where(eq(microApps.appId, dto.appId)).limit(1)
  const existingConfig = existing[0] ? (existing[0].config as MicroAppConfig) : null
  const publishList = existingConfig?.publishList
    ? [publishEntry, ...existingConfig.publishList]
    : [publishEntry]

  const config: MicroAppConfig = existingConfig
    ? { ...existingConfig, publishList }
    : {
        name: dto.name,
        appId: dto.appId,
        owner: dto.owner,
        gitLab: dto.gitLab,
        createTime: time,
        publishList,
      }

  await db.transaction(async (tx) => {
    await tx
      .insert(microApps)
      .values({
        appId: dto.appId,
        name: dto.name,
        baseroute: (dto as { baseroute?: string }).baseroute ?? "",
        url,
        microVersion: dto.version ?? "",
        config: config as Record<string, unknown>,
      })
      .onConflictDoUpdate({
        target: microApps.appId,
        set: {
          name: dto.name,
          url,
          microVersion: dto.version ?? "",
          config: config as Record<string, unknown>,
          rowVersion: sql`${microApps.rowVersion} + 1`,
          updatedAt: new Date(),
        },
      })
    await tx.execute(sql`SELECT pg_notify('gateway_config_changed', ${JSON.stringify({ table: "micro_apps", key: dto.appId })})`)
  })
  invalidateList()

  // 宿主 app 的 microApps 数组同步 upsert（HTML 注入源，原语义）
  if (dto.mainAppId) {
    const mainApp = await appService.getAppByAppId(dto.mainAppId)
    if (mainApp) {
      const microAppsList = (Array.isArray(mainApp.microApps) ? [...(mainApp.microApps as Record<string, unknown>[])] : []) as Record<string, unknown>[]
      const index = microAppsList.findIndex((item) => item.appId === dto.appId)
      const entry = { ...dto, url, version: dto.version ?? "", createTime: index >= 0 ? microAppsList[index]!.createTime : time }
      if (index >= 0) microAppsList[index] = { ...microAppsList[index], ...entry }
      else microAppsList.push(entry)
      await appService.updateAppConfig(dto.mainAppId, "incremental", { microApps: microAppsList })
    } else {
      logger.warn({ span: "microapps:publish", msg: `宿主应用不存在: ${dto.mainAppId}` })
    }
  }

  logger.info({ span: "microapps:publish", msg: `子应用已发布: ${dto.appId}@${dto.version ?? ""}` })
  return c.text("success")
})

// 原 PATCH /gw-api/microapps/:appId：更新 name/gitLab
microappsApp.patch("/:appId", async (c) => {
  const appId = c.req.param("appId")
  const dto = (await c.req.json().catch(() => null)) as { name?: string; gitLab?: string } | null
  if (!dto) return c.json({ success: false, message: "Invalid body" }, 400)

  const existing = await db.select().from(microApps).where(eq(microApps.appId, appId)).limit(1)
  if (!existing[0]) return c.json({ success: false, message: "微应用不存在" }, 404)
  const config = { ...(existing[0].config as Record<string, unknown>) }
  if (dto.name) config["name"] = dto.name
  if (dto.gitLab) config["gitLab"] = dto.gitLab

  await db
    .update(microApps)
    .set({
      ...(dto.name ? { name: dto.name } : {}),
      config,
      rowVersion: sql`${microApps.rowVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(microApps.appId, appId))
  invalidateList()
  return c.text(`This action updates a #${appId} microapp`)
})
