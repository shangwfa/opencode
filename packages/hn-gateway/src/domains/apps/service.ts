/**
 * 应用配置服务（替代原 NacosConfigService 的配置读取/写入与订阅缓存）。
 *
 * - 读：进程内 60s TTL 缓存（等价原 Nacos 订阅推送的近实时性），NOTIFY 失效兜底
 * - 写：同事务写表 + pg_notify（等价原 publishSingle）；full 覆盖 / incremental JSONB 合并
 * - 乐观锁：expectedVersion 不匹配返回 ConflictError（原 Nacos 为 last-write-wins，此处更强）
 */
import { and, eq, sql } from "drizzle-orm"
import { db, apps, configs } from "../../db/index.js"
import { logger } from "../../logger.js"

/** 原 Nacos IApp 形态原样透传，不做字段收敛 */
export type IApp = Record<string, unknown>
/** 原 IPlatform：`domain/baseRoute` 或 `domain` → IApp 的聚合映射 */
export type IPlatform = Record<string, IApp>

export class ConflictError extends Error {
  readonly statusCode = 409
  constructor(message = "配置版本冲突，请刷新后重试") {
    super(message)
  }
}

export class NotFoundError extends Error {
  readonly statusCode = 404
  constructor(message: string) {
    super(message)
  }
}

/** 缓存 TTL（默认 60s；GATEWAY_CACHE_TTL_MS 可调——测试/演练环境加速过期用） */
const APPS_TTL_MS = Number(process.env["GATEWAY_CACHE_TTL_MS"] || 60_000)
/** PG 不可达时的过期缓存降级上限（原 Nacos 客户端快照语义）：超过视为无数据可用 */
const STALE_MAX_MS = 10 * 60_000

interface CacheEntry<T> {
  value: T
  expires: number
}

/** PG 回源失败时的降级读取：过期但未超过 STALE_MAX 的缓存条目（无则 undefined） */
function staleEntry<T>(entry: CacheEntry<T> | null | undefined, key: string): T | undefined {
  if (!entry) return undefined
  const age = Date.now() - entry.expires
  if (age > STALE_MAX_MS) return undefined
  logger.warn({ span: "cache:stale-degrade", msg: `PG 不可达，降级使用过期缓存（age=${Math.round(age / 1000)}s）`, reqPath: key })
  return entry.value
}

export class AppService {
  private byDomainRoute = new Map<string, CacheEntry<IApp | null>>()
  private byAppId = new Map<string, CacheEntry<IApp | null>>()
  private platformCache: CacheEntry<IPlatform> | null = null

  // ── 读 ──

  /** 原 getAppByDomain：先 domain/baseRoute 精确匹配，再回退 domain 根应用 */
  async getAppByDomain(domain: string, baseRoute = ""): Promise<IApp | null> {
    const normalized = (domain || "").toLowerCase()
    const cacheKey = `${normalized}/${baseRoute}`
    const cached = this.byDomainRoute.get(cacheKey)
    if (cached && cached.expires > Date.now()) return cached.value

    try {
      const rows = await db
        .select({ config: apps.config, enabled: apps.enabled })
        .from(apps)
        .where(and(eq(apps.domain, normalized), eq(apps.baseRoute, baseRoute)))
        .limit(1)
      let value: IApp | null = rows[0] ? (rows[0].config as IApp) : null
      if (!value && baseRoute) {
        // 回退根应用（原 config[domain] 语义）
        const rootRows = await db
          .select({ config: apps.config, enabled: apps.enabled })
          .from(apps)
          .where(and(eq(apps.domain, normalized), eq(apps.baseRoute, "")))
          .limit(1)
        value = rootRows[0] ? (rootRows[0].config as IApp) : null
      }
      if (rows[0] && rows[0].enabled === false) value = null

      this.byDomainRoute.set(cacheKey, { value, expires: Date.now() + APPS_TTL_MS })
      return value
    } catch (error) {
      // PG 不可达：降级用过期缓存（原 Nacos 客户端断连快照语义）
      const stale = staleEntry(this.byDomainRoute.get(cacheKey), cacheKey)
      if (stale !== undefined) return stale
      throw error
    }
  }

  async getAppByAppId(appId: string): Promise<IApp | null> {
    const cached = this.byAppId.get(appId)
    if (cached && cached.expires > Date.now()) return cached.value
    try {
      const rows = await db.select({ config: apps.config }).from(apps).where(eq(apps.appId, appId)).limit(1)
      const value = rows[0] ? (rows[0].config as IApp) : null
      this.byAppId.set(appId, { value, expires: Date.now() + APPS_TTL_MS })
      return value
    } catch (error) {
      const stale = staleEntry(this.byAppId.get(appId), appId)
      if (stale !== undefined) return stale
      throw error
    }
  }

  /** 原 getConfig/updateConfig 的聚合视图：`domain/baseRoute`（或 `domain`）→ IApp */
  async getPlatform(): Promise<IPlatform> {
    if (this.platformCache && this.platformCache.expires > Date.now()) return this.platformCache.value
    try {
      const rows = await db
        .select({ appId: apps.appId, domain: apps.domain, baseRoute: apps.baseRoute, config: apps.config })
        .from(apps)
      const platform: IPlatform = {}
      for (const row of rows) {
        const key = row.baseRoute ? `${row.domain}/${row.baseRoute}` : row.domain
        platform[key] = { appId: row.appId, ...(row.config as IApp) }
      }
      this.platformCache = { value: platform, expires: Date.now() + APPS_TTL_MS }
      return platform
    } catch (error) {
      // PG 不可达：降级用过期聚合视图
      const stale = staleEntry(this.platformCache ?? null, "platform")
      if (stale !== undefined) return stale
      throw error
    }
  }

  // ── 写（写表 + 同事务 NOTIFY）──

  /** full 写入：upsert 整个 app 配置 */
  async upsertApp(input: {
    appId: string
    domain: string
    baseRoute?: string
    config: IApp
    enabled?: boolean
  }): Promise<{ version: number }> {
    const domain = input.domain.toLowerCase()
    const baseRoute = input.baseRoute ?? ""
    return db.transaction(async (tx) => {
      const result = await tx
        .insert(apps)
        .values({
          appId: input.appId,
          domain,
          baseRoute,
          config: input.config,
          enabled: input.enabled ?? true,
        })
        .onConflictDoUpdate({
          target: apps.appId,
          set: {
            domain,
            baseRoute,
            config: input.config,
            enabled: input.enabled ?? true,
            version: sql`${apps.version} + 1`,
            updatedAt: new Date(),
          },
        })
        .returning({ version: apps.version })
      await notifyApps(tx, input.appId)
      // 对齐原 Nacos 客户端语义：自身发布的变更本地缓存同步失效
      this.invalidate({ table: "apps", key: input.appId })
      return { version: result[0]!.version }
    })
  }

  /**
   * 原 updateAppConfig(appId, mode, config)：
   * - full：整体替换 config
   * - incremental：JSONB 浅合并（config || new）
   * - expectedVersion 提供时校验乐观锁，不匹配抛 ConflictError
   */
  async updateAppConfig(
    appId: string,
    mode: "full" | "incremental",
    config: IApp,
    expectedVersion?: number,
  ): Promise<{ version: number; config: IApp }> {
    return db.transaction(async (tx) => {
      const set = {
        ...(mode === "full"
          ? { config: config as Record<string, unknown> }
          : { config: sql`${apps.config} || ${JSON.stringify(config)}::jsonb` }),
        version: sql`${apps.version} + 1`,
        updatedAt: new Date(),
      }
      const condition = expectedVersion == null ? eq(apps.appId, appId) : and(eq(apps.appId, appId), eq(apps.version, expectedVersion))
      const result = await tx
        .update(apps)
        .set(set)
        .where(condition)
        .returning({ version: apps.version, config: apps.config })
      if (!result[0]) {
        const exists = await tx.select({ v: apps.version }).from(apps).where(eq(apps.appId, appId)).limit(1)
        if (exists[0]) throw new ConflictError()
        throw new NotFoundError(`应用不存在: ${appId}`)
      }
      await notifyApps(tx, appId)
      this.invalidate({ table: "apps", key: appId })
      return { version: result[0].version, config: result[0].config as IApp }
    })
  }

  /** 原 setCachedConfig（修缓存）：把 IPlatform 批量落库（写穿），返回处理条数 */
  async fixPlatformCache(platform: IPlatform): Promise<number> {
    let count = 0
    for (const [key, value] of Object.entries(platform)) {
      if (!value || typeof value !== "object") continue
      const appId = typeof value.appId === "string" ? value.appId : ""
      if (!appId) {
        logger.warn({ span: "nacos:cache-fix:skip", msg: `缺少 appId，跳过: ${key}` })
        continue
      }
      const slash = key.indexOf("/")
      const domain = (slash >= 0 ? key.slice(0, slash) : key).toLowerCase()
      const baseRoute = slash >= 0 ? key.slice(slash + 1) : ""
      await this.upsertApp({ appId, domain, baseRoute, config: value })
      count += 1
    }
    this.invalidateAll()
    return count
  }

  /** configs KV（private-info 等平台级配置） */
  async getConfig(key: string): Promise<unknown> {
    const rows = await db.select({ value: configs.value }).from(configs).where(eq(configs.key, key)).limit(1)
    return rows[0]?.value ?? null
  }

  async putConfig(key: string, value: unknown): Promise<void> {
    await db.transaction(async (tx) => {
      await tx
        .insert(configs)
        .values({ key, value: value as Record<string, unknown> })
        .onConflictDoUpdate({
          target: configs.key,
          set: { value: value as Record<string, unknown>, version: sql`${configs.version} + 1`, updatedAt: new Date() },
        })
      await tx.execute(
        sql`SELECT pg_notify('gateway_config_changed', ${JSON.stringify({ table: "configs", key })})`,
      )
    })
    if (key === "platform") this.platformCache = null
  }

  // ── 缓存失效 ──

  /** health 降级判断：是否存在可用的（新鲜或 stale 未超限的）应用缓存条目 */
  hasAnyCachedApp(): boolean {
    const now = Date.now()
    const usable = (entry: CacheEntry<IApp | null> | undefined) =>
      entry !== undefined && entry.value !== null && now - entry.expires <= STALE_MAX_MS
    for (const entry of this.byDomainRoute.values()) if (usable(entry)) return true
    for (const entry of this.byAppId.values()) if (usable(entry)) return true
    return false
  }

  invalidate(change: { table: string; key: string }): void {
    if (change.table !== "apps" && change.table !== "configs") return
    this.byAppId.clear()
    this.byDomainRoute.clear()
    this.platformCache = null
  }

  invalidateAll(): void {
    this.byAppId.clear()
    this.byDomainRoute.clear()
    this.platformCache = null
  }

  stats(): { byAppId: number; byDomainRoute: number } {
    return { byAppId: this.byAppId.size, byDomainRoute: this.byDomainRoute.size }
  }
}

/** 同事务 NOTIFY apps 变更 */
function notifyApps(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], appId: string) {
  return tx.execute(sql`SELECT pg_notify('gateway_config_changed', ${JSON.stringify({ table: "apps", key: appId } satisfies { table: string; key: string })})`)
}

export const appService = new AppService()
