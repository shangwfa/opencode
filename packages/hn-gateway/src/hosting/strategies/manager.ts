/**
 * 前端版本灰度策略管理器（原 GrayReleaseStrategyManager）。
 *
 * 优先级：请求头 version（测试用，最高）→ 策略按 priority 升序 → 兜底 app.version。
 * P4 注册四策略：backend-gray(50) / user-enterprise(100) / network(150) / percent(175)。
 */
import type { Context } from "hono"
import type { IApp } from "../../domains/apps/service.js"
import { logger } from "../../logger.js"

export interface StrategyContext {
  c: Context
  req: Request
  app: IApp
  domain: string
  baseUrl: string
  traceId: string
}

export interface GrayReleaseResult {
  version: string
  strategy: string
}

export interface GrayReleaseStrategy {
  readonly name: string
  readonly priority: number
  selectVersion(context: StrategyContext): GrayReleaseResult | null | Promise<GrayReleaseResult | null>
}

export class GrayReleaseStrategyManager {
  private readonly strategies: GrayReleaseStrategy[]

  constructor(strategies: GrayReleaseStrategy[] = []) {
    this.strategies = [...strategies].sort((a, b) => a.priority - b.priority)
  }

  async selectVersion(context: StrategyContext): Promise<string> {
    const { req, app, traceId, domain } = context

    // 1. 请求头 version 优先（原"测试功能"语义）
    const requestVersion = req.headers.get("version")
    if (requestVersion) {
      logger.info({
        span: "strategy:selected",
        traceId,
        domain,
        reqPath: new URL(req.url).pathname,
        msg: "使用请求头版本",
        strategy: "request-header",
        version: requestVersion,
        appId: String(app.appId ?? ""),
      })
      return requestVersion
    }

    // 2. 策略按 priority 升序尝试（backend-gray 50 / user-enterprise 100 / network 150 / percent 175）
    for (const strategy of this.strategies) {
      const result = await strategy.selectVersion(context)
      if (result) {
        logger.info({
          span: "strategy:selected",
          traceId,
          domain,
          msg: "策略选择版本",
          strategy: strategy.name,
          version: result.version,
          appId: String(app.appId ?? ""),
        })
        return result.version
      }
    }

    // 3. 兜底 app.version
    return String(app.version ?? "")
  }
}

export const strategyManager = new GrayReleaseStrategyManager()
