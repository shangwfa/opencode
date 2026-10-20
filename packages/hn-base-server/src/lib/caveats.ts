/**
 * Caveat 求值（轻量 ABAC）。
 *
 * 元组可挂 `caveatName + caveatContext`；判定时传入请求上下文（ctx）。
 * 未知 caveat 一律拒绝（fail-closed）。
 */

export type CaveatContext = Record<string, unknown>

export type RequestContext = {
  now?: number
  ip?: string
  mfaVerified?: boolean
  [key: string]: unknown
}

/** 简单 IPv4 CIDR 匹配（IPv6 暂不支持，直接不匹配） */
export function ipInCidr(ip: string, cidr: string): boolean {
  const [range, bitsRaw] = cidr.trim().split("/")
  if (!range) return false
  const bits = Number(bitsRaw ?? 32)
  const toInt = (value: string) => {
    const parts = value.trim().split(".")
    if (parts.length !== 4) return undefined
    let n = 0
    for (const part of parts) {
      const v = Number(part)
      if (!Number.isInteger(v) || v < 0 || v > 255) return undefined
      n = (n << 8) | v
    }
    return n >>> 0
  }
  const a = toInt(ip)
  const b = toInt(range)
  if (a === undefined || b === undefined) return false
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false
  if (bits === 0) return true
  const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0
  return (a & mask) === (b & mask)
}

/** 求值：返回 true 表示条件满足（元组有效） */
export function evaluateCaveat(
  name: string,
  data: CaveatContext | null | undefined,
  ctx?: RequestContext,
): boolean {
  const now = ctx?.now ?? Date.now()
  const payload = data ?? {}

  switch (name) {
    case "expires_after": {
      const expires = Number(payload.expires_at ?? payload.expiresAt ?? 0)
      if (!Number.isFinite(expires) || expires <= 0) return false
      return now < expires
    }

    case "mfa":
      return ctx?.mfaVerified === true

    case "ip_allowlist": {
      const list = (payload.cidrs ?? payload.ip_allowlist ?? []) as unknown
      const ip = ctx?.ip
      if (!ip || !Array.isArray(list)) return false
      return list.some((cidr) => typeof cidr === "string" && ipInCidr(ip, cidr))
    }

    case "time_window": {
      // { start: "09:00", end: "18:00" }（本地时间按 UTC 简化）
      const date = new Date(now)
      const minutes = date.getUTCHours() * 60 + date.getUTCMinutes()
      const parse = (value: unknown) => {
        if (typeof value !== "string") return undefined
        const [h, m] = value.split(":").map(Number)
        if (h === undefined || m === undefined || !Number.isFinite(h) || !Number.isFinite(m)) return undefined
        return h * 60 + m
      }
      const start = parse(payload.start)
      const end = parse(payload.end)
      if (start === undefined || end === undefined) return false
      return start <= end ? minutes >= start && minutes <= end : minutes >= start || minutes <= end
    }

    default:
      // 未知条件：保守拒绝
      return false
  }
}
