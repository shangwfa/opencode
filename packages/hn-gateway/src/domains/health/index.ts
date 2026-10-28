import { Hono } from "hono"
import { db, apps } from "../../db/index.js"
import { appService } from "../apps/service.js"
import { logger } from "../../logger.js"

/**
 * GET /health（原 health.controller 语义：配置就绪检查，配置为空时 503 摘流量）。
 * 分层判定（K8s 多 pod 语义）：
 * 1. PG 可达且 apps 有数据 → healthy（configCount）
 * 2. PG 不可达但缓存有可用条目（新鲜或 stale≤10min，见 apps/service stale 降级）
 *    → 仍 healthy（db:down + degraded:true）——PG 短暂抖动不摘掉还在降级服务的 pod
 * 3. PG 可达但 apps 为空 → 503（配置未就绪）
 * 4. PG 不可达且无可用缓存 → 503
 * 注意：本路由不走响应包装（原实现 @Res 直写，绕过 interceptor）。
 */
export const healthApp = new Hono().get("/", async (c) => {
  let configCount: number
  try {
    const rows = await db.select({ appId: apps.appId }).from(apps)
    configCount = rows.length
    if (configCount === 0) {
      return c.json(
        {
          status: "unhealthy",
          reason: "no_config_available",
          message: "Nacos configuration is not available",
          initialized: true,
          configCount: 0,
        },
        503,
      )
    }
    return c.json({
      status: "healthy",
      message: "Service is healthy",
      initialized: true,
      configCount,
    })
  } catch (error) {
    const degraded = appService.hasAnyCachedApp()
    const message = error instanceof Error ? error.message : String(error)
    logger.error({ span: "health:db", msg: `PG 不可达${degraded ? "（缓存降级可用）" : "（无可用缓存）"}`, error: message })
    if (degraded) {
      return c.json({
        status: "healthy",
        message: "Service is healthy (degraded: serving stale config from cache)",
        initialized: true,
        db: "down",
        degraded: true,
      })
    }
    return c.json(
      {
        status: "unhealthy",
        reason: "error",
        message: "Health check failed",
        error: message,
      },
      503,
    )
  }
})
