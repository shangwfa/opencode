/**
 * network 策略（priority 150；原 NetworkStrategy 一比一迁移）。
 * app.internalCanary.{enabled,version} + env INTERNAL_GRAY_IPS（逗号分隔，支持 CIDR），
 * 客户端 IP 取 x-forwarded-for 首值 / x-real-ip（等价原 get-client-ip），剥离 ::ffff: 前缀。
 */
import type { GrayReleaseResult, GrayReleaseStrategy, StrategyContext } from "./manager.js"

interface InternalCanaryConfig {
  enabled?: boolean
  version?: string
}

/** IPv4 CIDR 匹配（等价原 ip-range-check 的用法面） */
function ipToLong(ip: string): number | null {
  const parts = ip.split(".")
  if (parts.length !== 4) return null
  let result = 0
  for (const part of parts) {
    const n = Number(part)
    if (!Number.isInteger(n) || n < 0 || n > 255) return null
    result = result * 256 + n
  }
  return result
}

function isIpInCidr(ip: string, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split("/")
  const bits = Number(bitsRaw)
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return ip === cidr
  const ipLong = ipToLong(ip)
  const baseLong = ipToLong(base)
  if (ipLong === null || baseLong === null) return ip === cidr
  if (bits === 0) return true
  const mask = (0xffffffff << (32 - bits)) >>> 0
  return (ipLong & mask) === (baseLong & mask)
}

export class NetworkStrategy implements GrayReleaseStrategy {
  readonly name = "network"
  readonly priority = 150

  selectVersion(context: StrategyContext): GrayReleaseResult | null {
    const { req, app } = context
    const internalCanary = app.internalCanary as InternalCanaryConfig | undefined
    if (!internalCanary?.enabled) return null

    const clientIp = this.getClientIp(req)
    if (!clientIp) return null

    const internalGrayIps = process.env["INTERNAL_GRAY_IPS"]
    if (!internalGrayIps) return null

    const ipList = internalGrayIps
      .split(",")
      .map((ip) => ip.trim())
      .filter((ip) => ip.length > 0)
    if (ipList.length === 0) return null

    // IPv6 映射的 IPv4 地址剥离前缀
    const cleanClientIp = clientIp.replace("::ffff:", "")
    if (ipList.some((entry) => (entry.includes("/") ? isIpInCidr(cleanClientIp, entry) : entry === cleanClientIp))) {
      return { version: internalCanary.version ?? "", strategy: this.name }
    }
    return null
  }

  private getClientIp(req: Request): string {
    const forwarded = req.headers.get("x-forwarded-for")
    if (forwarded) return forwarded.split(",")[0]!.trim()
    return req.headers.get("x-real-ip") ?? ""
  }
}
