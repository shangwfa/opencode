/**
 * backend-gray 策略（priority 50，最高；原 BackendGrayStrategy 一比一迁移）。
 *
 * 原 Nacos/API 轮询的 feature 路由配置由 PG gray_features 表 + 30s TTL 缓存承接
 * （见 domains/ap/index.ts 的 getGrayFeature）；"拉取失败降级用缓存"的语义由
 * TTL 缓存天然满足——PG 即源，无需降级路径。
 *
 * 判定顺序：app.backendGray.{enabled,featureKey,version} → 时间窗 → 黑名单
 * （命中返回 blackListVersion 或 null）→ globalEnabled 全局放行 → 白名单 OR
 * Java hashCode 分桶（Math.abs(hash % 100) < percentage，bucketKey 按
 * percentageKey 取 cookie uuid/enterpriseUuid）。
 */
import type { GrayReleaseResult, GrayReleaseStrategy, StrategyContext } from "./manager.js"
import { getGrayFeature } from "../../domains/ap/index.js"
import { parseCookies } from "../utils/cookie.js"

/** 原 GrayFeatureRouteConfig 形态原样保留 */
export interface GrayFeatureRouteConfig {
  featureKey: string
  version: number
  defaultStatus: boolean
  globalEnabled: boolean
  percentage: number
  percentageKey: string
  startTime: string | null
  endTime: string | null
  metadata: Record<string, unknown>
  whiteList: {
    userId?: string[]
    orgId?: string[]
    tenantId?: string[]
  }
  blackList: {
    userId?: string[]
    orgId?: string[]
    tenantId?: string[]
  }
}

/** Java String.hashCode 算法（32 位有符号溢出，与后端一致） */
export function javaStringHashCode(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) | 0
  }
  return hash
}

interface BackendGrayAppConfig {
  enabled?: boolean
  featureKey?: string
  version?: string
  blackListVersion?: string
}

export class BackendGrayStrategy implements GrayReleaseStrategy {
  readonly name = "backend-gray"
  readonly priority = 50

  async selectVersion(context: StrategyContext): Promise<GrayReleaseResult | null> {
    const { req, app } = context
    const backendGray = app.backendGray as BackendGrayAppConfig | undefined
    if (!backendGray?.enabled) return null
    const { featureKey, version: grayVersion } = backendGray
    if (!featureKey || !grayVersion) return null

    const config = (await getGrayFeature(featureKey)) as GrayFeatureRouteConfig | null
    if (!config) return null

    // 时间窗检查
    const now = new Date()
    if (config.startTime && now < new Date(config.startTime)) return null
    if (config.endTime && now > new Date(config.endTime)) return null

    const cookieMap = parseCookies(req.headers.get("cookie"))
    const userId = cookieMap["uuid"] ?? ""
    const orgId = cookieMap["enterpriseUuid"] ?? ""
    const tenantId = cookieMap["tenantId"] ?? ""

    // 黑名单检查（命中返回 blackListVersion 或 null）
    if (config.blackList) {
      const blacklisted =
        (userId && config.blackList.userId?.includes(userId)) ||
        (orgId && config.blackList.orgId?.includes(orgId)) ||
        (tenantId && config.blackList.tenantId?.includes(tenantId))
      if (blacklisted) {
        return backendGray.blackListVersion ? { version: backendGray.blackListVersion, strategy: this.name } : null
      }
    }

    // 全局开放
    if (config.globalEnabled) return { version: grayVersion, strategy: this.name }

    // 白名单
    const inWhiteList =
      (userId && config.whiteList?.userId?.includes(userId)) ||
      (orgId && config.whiteList?.orgId?.includes(orgId)) ||
      (tenantId && config.whiteList?.tenantId?.includes(tenantId))

    // 概率灰度（独立判断，与白名单互不影响）
    let percentagePassed = false
    if (config.percentageKey) {
      if (config.percentage > 0) {
        const hashInput = config.percentageKey === "userId" ? userId : config.percentageKey === "orgId" ? orgId : ""
        if (hashInput) {
          const hashValue = Math.abs(javaStringHashCode(hashInput) % 100)
          percentagePassed = hashValue < config.percentage
        }
      }
    }

    return inWhiteList || percentagePassed ? { version: grayVersion, strategy: this.name } : null
  }
}
