/**
 * user-enterprise 策略（priority 100；原 UserEnterpriseStrategy 一比一迁移）。
 * app.canary[]：企业级 enterpriseUuid → version，用户级 users[].uuid → version 优先。
 */
import type { GrayReleaseResult, GrayReleaseStrategy, StrategyContext } from "./manager.js"
import { parseCookies } from "../utils/cookie.js"

export interface CanaryConfig {
  enterpriseUuid: string
  version: string
  users?: { uuid: string; version: string }[]
}

export class UserEnterpriseStrategy implements GrayReleaseStrategy {
  readonly name = "user-enterprise"
  readonly priority = 100

  selectVersion(context: StrategyContext): GrayReleaseResult | null {
    const { req, app } = context
    const canary = app.canary as CanaryConfig[] | undefined
    if (!canary || canary.length === 0) return null

    const cookieMap = parseCookies(req.headers.get("cookie"))
    const uuid = cookieMap["uuid"] ?? ""
    const enterpriseUuid = cookieMap["enterpriseUuid"] ?? ""
    if (!uuid || !enterpriseUuid) return null

    const enterpriseMatch = canary.find((config) => config.enterpriseUuid === enterpriseUuid)
    if (!enterpriseMatch) return null

    // 用户级配置优先
    if (enterpriseMatch.users && enterpriseMatch.users.length > 0) {
      const userMatch = enterpriseMatch.users.find((user) => user.uuid === uuid)
      if (userMatch) return { version: userMatch.version, strategy: this.name }
    }

    // 企业级配置
    return { version: enterpriseMatch.version, strategy: this.name }
  }
}
