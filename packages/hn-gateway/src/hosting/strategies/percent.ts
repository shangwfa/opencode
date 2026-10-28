/**
 * percent 策略（priority 175；原 PercentStrategy 一比一迁移）。
 * app.percentCanary.{version,percentage}：
 * - cookie `gray_hash_{appId}` 为 `{version}:{hash}` 且版本匹配时复用（0≤hash<100）
 * - 否则 md5(traceId) 前 8 位 hex → %100（Nginx 风格），并回写 cookie（path=/，30 天）
 * - hash < percentage 命中灰度版本
 */
import { createHash } from "node:crypto"
import type { Context } from "hono"
import { setCookie, getCookie } from "hono/cookie"
import type { GrayReleaseResult, GrayReleaseStrategy, StrategyContext } from "./manager.js"

export interface PercentCanaryConfig {
  version: string
  percentage: number
}

export class PercentStrategy implements GrayReleaseStrategy {
  readonly name = "percent"
  readonly priority = 175

  selectVersion(context: StrategyContext): GrayReleaseResult | null {
    const { app, traceId } = context
    const percentCanary = app.percentCanary as PercentCanaryConfig | undefined
    if (!percentCanary) return null

    const cookieName = `gray_hash_${String(app.appId)}`

    // 1. 读取或计算哈希（cookie 版本匹配才复用，保证灰度版本切换后重新分桶）
    let hashValue = this.getHashFromCookie(context, cookieName, percentCanary.version)
    if (hashValue === null) {
      hashValue = this.calculateHash(traceId)
      this.setHashCookie(context, cookieName, percentCanary.version, hashValue)
    }

    return hashValue < percentCanary.percentage ? { version: percentCanary.version, strategy: this.name } : null
  }

  private getHashFromCookie(context: StrategyContext, cookieName: string, currentVersion: string): number | null {
    const value = getCookie(context.c, cookieName)
    if (typeof value !== "string") return null
    const parts = value.split(":")
    if (parts.length !== 2) return null
    const [cookieVersion, hashStr] = parts as [string, string]
    const hashValue = parseInt(hashStr, 10)
    if (cookieVersion === currentVersion && !isNaN(hashValue) && hashValue >= 0 && hashValue < 100) {
      return hashValue
    }
    return null
  }

  private setHashCookie(context: StrategyContext, name: string, version: string, hashValue: number): void {
    // 原 res.cookie：maxAge 30 天、path=/、httpOnly=false
    setCookie(context.c, name, `${version}:${hashValue}`, {
      path: "/",
      maxAge: 30 * 24 * 60 * 60,
      httpOnly: false,
    })
  }

  /** Nginx 风格哈希：md5 前 8 位 hex → %100 */
  private calculateHash(traceId: string): number {
    const hash = createHash("md5").update(traceId).digest("hex")
    return parseInt(hash.substring(0, 8), 16) % 100
  }
}
