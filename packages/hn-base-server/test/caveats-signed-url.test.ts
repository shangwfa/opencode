import { describe, expect, it } from "bun:test"
import { evaluateCaveat, ipInCidr } from "../src/lib/caveats.js"
import { buildSignedPath, signPath, verifyPath } from "../src/lib/signed-url.js"

describe("caveats/expires_after", () => {
  it("未过期通过", () => {
    const now = 1_000_000
    expect(evaluateCaveat("expires_after", { expires_at: now + 1000 }, { now })).toBe(true)
  })
  it("已过期拒绝", () => {
    const now = 1_000_000
    expect(evaluateCaveat("expires_after", { expires_at: now - 1 }, { now })).toBe(false)
  })
  it("缺少 expires_at 拒绝", () => {
    expect(evaluateCaveat("expires_after", {}, { now: 1 })).toBe(false)
  })
})

describe("caveats/mfa", () => {
  it("已验证通过", () => {
    expect(evaluateCaveat("mfa", {}, { mfaVerified: true })).toBe(true)
  })
  it("未验证拒绝", () => {
    expect(evaluateCaveat("mfa", {}, { mfaVerified: false })).toBe(false)
    expect(evaluateCaveat("mfa", {}, {})).toBe(false)
  })
})

describe("caveats/ip_allowlist", () => {
  it("命中 CIDR", () => {
    expect(evaluateCaveat("ip_allowlist", { cidrs: ["10.0.0.0/8"] }, { ip: "10.1.2.3" })).toBe(true)
  })
  it("未命中 CIDR", () => {
    expect(evaluateCaveat("ip_allowlist", { cidrs: ["10.0.0.0/8"] }, { ip: "192.168.1.1" })).toBe(false)
  })
  it("无 IP 拒绝", () => {
    expect(evaluateCaveat("ip_allowlist", { cidrs: ["10.0.0.0/8"] }, {})).toBe(false)
  })
})

describe("caveats/ipInCidr", () => {
  it("/32 精确匹配", () => {
    expect(ipInCidr("1.2.3.4", "1.2.3.4/32")).toBe(true)
    expect(ipInCidr("1.2.3.5", "1.2.3.4/32")).toBe(false)
  })
  it("/0 匹配全部", () => {
    expect(ipInCidr("8.8.8.8", "0.0.0.0/0")).toBe(true)
  })
  it("/24 网段", () => {
    expect(ipInCidr("192.168.1.200", "192.168.1.0/24")).toBe(true)
    expect(ipInCidr("192.168.2.1", "192.168.1.0/24")).toBe(false)
  })
  it("非法输入返回 false", () => {
    expect(ipInCidr("not-an-ip", "10.0.0.0/8")).toBe(false)
    expect(ipInCidr("10.0.0.1", "10.0.0.0/99")).toBe(false)
    expect(ipInCidr("::1", "::/0")).toBe(false)
  })
})

describe("caveats/time_window", () => {
  it("窗口内通过", () => {
    const now = Date.UTC(2026, 0, 1, 10, 0)
    expect(evaluateCaveat("time_window", { start: "09:00", end: "18:00" }, { now })).toBe(true)
  })
  it("窗口外拒绝", () => {
    const now = Date.UTC(2026, 0, 1, 20, 0)
    expect(evaluateCaveat("time_window", { start: "09:00", end: "18:00" }, { now })).toBe(false)
  })
  it("跨午夜窗口", () => {
    const now = Date.UTC(2026, 0, 1, 23, 0)
    expect(evaluateCaveat("time_window", { start: "22:00", end: "06:00" }, { now })).toBe(true)
  })
})

describe("caveats/未知条件", () => {
  it("未知 caveat 保守拒绝", () => {
    expect(evaluateCaveat("future_rule", {}, {})).toBe(false)
  })
})

describe("signed-url", () => {
  it("签名校验往返", () => {
    const exp = Date.now() + 60_000
    const sig = signPath("ses_1", "src/a.ts", exp)
    expect(verifyPath("ses_1", "src/a.ts", exp, sig)).toBe(true)
  })

  it("路径被篡改则失败", () => {
    const exp = Date.now() + 60_000
    const sig = signPath("ses_1", "src/a.ts", exp)
    expect(verifyPath("ses_1", "src/b.ts", exp, sig)).toBe(false)
  })

  it("会话被篡改则失败（不能跨会话复用）", () => {
    const exp = Date.now() + 60_000
    const sig = signPath("ses_1", "src/a.ts", exp)
    expect(verifyPath("ses_2", "src/a.ts", exp, sig)).toBe(false)
  })

  it("过期后失效", () => {
    const now = Date.now()
    const exp = now - 1
    const sig = signPath("ses_1", "src/a.ts", exp)
    expect(verifyPath("ses_1", "src/a.ts", exp, sig, now)).toBe(false)
  })

  it("buildSignedPath 带 path/exp/sig", () => {
    const { url, expiresAt } = buildSignedPath("ses_1", "assets/logo.png")
    expect(url).toContain("/api/public/fs/ses_1/content")
    expect(url).toContain("path=assets%2Flogo.png")
    expect(url).toContain(`exp=${expiresAt}`)
    expect(url).toContain("sig=")
    expect(expiresAt).toBeGreaterThan(Date.now())
  })
})
