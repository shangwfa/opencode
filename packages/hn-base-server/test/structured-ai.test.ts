import { describe, expect, test } from "bun:test"
import { providerErrorSummary } from "../src/lib/structured-ai"

describe("provider 错误整理为用户可读提示", () => {
  test("额度/限流转成可操作中文，不泄露原始 JSON", () => {
    const message = providerErrorSummary({
      type: "provider.quota",
      message: "Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe: https://opencode.ai/go",
      status: 429,
    })
    expect(message).toContain("模型额度已用完")
    expect(message).toContain("429")
    expect(message).not.toContain("{")
    expect(message).not.toContain("https://opencode.ai/go")
  })

  test("鉴权与 5xx 分别给出对应提示", () => {
    expect(providerErrorSummary({ type: "ProviderAuthError", message: "invalid api key" })).toContain("未授权")
    expect(providerErrorSummary({ status: 503, message: "Overloaded" })).toContain("暂时不可用")
  })

  test("未知错误只保留简短消息，不输出结构体", () => {
    const message = providerErrorSummary({ message: "boom", status: 418 })
    expect(message).toContain("boom")
    expect(message).toContain("418")
    expect(message).not.toContain("{")
  })
})
