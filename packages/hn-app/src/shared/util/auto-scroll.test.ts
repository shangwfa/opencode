import { describe, expect, it } from "vitest"
import { bottomScrollTop, hasOverflow, isNearBottom } from "./auto-scroll"

describe("isNearBottom", () => {
  it("贴底（差值 0）→ true", () => {
    expect(isNearBottom({ scrollTop: 400, scrollHeight: 1000, clientHeight: 600 })).toBe(true)
  })

  it("阈值内仍算贴底", () => {
    expect(isNearBottom({ scrollTop: 370, scrollHeight: 1000, clientHeight: 600 }, 64)).toBe(true)
  })

  it("用户上滚超出阈值 → false（停止自动跟随）", () => {
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 4000, clientHeight: 600 })).toBe(false)
  })

  it("内容不足一屏 → true（否则会误判为上滚）", () => {
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 600 })).toBe(true)
  })

  it("非法度量按贴底处理，避免异常值锁死滚动", () => {
    expect(isNearBottom({ scrollTop: NaN, scrollHeight: 1000, clientHeight: 600 })).toBe(true)
  })
})

describe("hasOverflow", () => {
  it("内容高于容器 → true", () => {
    expect(hasOverflow({ scrollTop: 0, scrollHeight: 900, clientHeight: 600 })).toBe(true)
  })

  it("内容不超过容器 → false", () => {
    expect(hasOverflow({ scrollTop: 0, scrollHeight: 600, clientHeight: 600 })).toBe(false)
  })
})

describe("bottomScrollTop", () => {
  it("取 scrollHeight（浏览器会自行夹到最大可滚动位置）", () => {
    expect(bottomScrollTop({ scrollHeight: 1234 })).toBe(1234)
  })
})
