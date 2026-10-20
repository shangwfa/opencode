import { describe, expect, test } from "vitest"
import { findProviderModel, tokenBreakdownFromSession, usagePercent } from "./session-token-usage"

describe("session token usage helpers", () => {
  test("computes cumulative token breakdown from session aggregate", () => {
    const breakdown = tokenBreakdownFromSession({
      id: "ses_1",
      tokens: {
        input: 100,
        output: 20,
        reasoning: 30,
        cache: { read: 40, write: 10 },
      },
    })

    expect(breakdown).toEqual({
      input: 100,
      output: 20,
      reasoning: 30,
      cacheRead: 40,
      cacheWrite: 10,
      total: 200,
    })
  })

  test("matches provider and model by the session model reference", () => {
    const result = findProviderModel(
      { providerID: "Yd-DeepSeek", id: "deepseek-v4-flash" },
      [
        {
          id: "Yd-DeepSeek",
          name: "Yd",
          models: {
            "deepseek-v4-flash": {
              name: "DeepSeek V4 Flash",
              limit: { context: 1_000_000 },
            },
          },
        },
      ],
    )

    expect(result.providerLabel).toBe("Yd")
    expect(result.modelLabel).toBe("DeepSeek V4 Flash")
    expect(result.limit).toBe(1_000_000)
  })

  test("allows cumulative usage to exceed 100 percent", () => {
    expect(usagePercent(2_500_000, 1_000_000)).toBe(250)
  })
})
