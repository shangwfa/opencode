import { describe, expect, test } from "vitest"
import { sessionErrorText } from "./session-error"

describe("执行错误文案", () => {
  test("免费模型出口 IP 被拒绝时给出明确恢复建议", () => {
    expect(sessionErrorText({ status: 403, message: "OpenCode's free models aren't available because abusive traffic from this IP address was detected." }))
      .toContain("HTTP 403，出口 IP 受限")
  })
  test("不把其他鉴权错误误判为免费模型受限", () => {
    expect(sessionErrorText({ status: 403, message: "API key invalid" })).toBe("API key invalid")
  })
  test("保留普通错误消息，为缺失内容提供兜底", () => {
    expect(sessionErrorText("连接中断")).toBe("连接中断")
    expect(sessionErrorText({ message: "模型不存在" })).toBe("模型不存在")
    expect(sessionErrorText(undefined)).toContain("执行失败")
  })
})
