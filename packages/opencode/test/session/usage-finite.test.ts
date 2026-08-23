import { describe, expect, test } from "bun:test"
import type { Provider } from "@opencode-ai/core/provider"
import { Session } from "@/session/session"

const model = (cost: Record<string, unknown>) =>
  ({
    id: "test-model",
    providerID: "test",
    name: "Test",
    limit: { context: 200_000, output: 8_000 },
    cost,
    capabilities: {},
    api: { npm: "@ai-sdk/test" },
    options: {},
  }) as never as Provider.Model

const usage = (overrides: Record<string, number | undefined>) =>
  ({
    inputTokens: 100,
    outputTokens: 50,
    reasoningTokens: 10,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    totalTokens: 150,
    ...overrides,
  }) as never

describe("session.getUsage finite/safe guards", () => {
  test("negative token counts are clamped to 0", () => {
    const result = Session.getUsage({
      model: model({ input: 3, output: 15, cache: { read: 0, write: 0 } }),
      usage: usage({ inputTokens: -5, outputTokens: -2, reasoningTokens: -1 }),
    })
    expect(result.tokens.input).toBe(0)
    expect(result.tokens.output).toBe(0)
    expect(result.tokens.reasoning).toBe(0)
  })

  test("non-finite cost rates do not produce NaN/Infinity cost", () => {
    const result = Session.getUsage({
      model: model({ input: Number.NaN, output: Number.POSITIVE_INFINITY, cache: { read: 0, write: 0 } }),
      usage: usage({}),
    })
    expect(Number.isFinite(result.cost)).toBe(true)
    expect(result.cost).toBe(0)
  })

  test("negative costInfo values are clamped before multiplication", () => {
    const result = Session.getUsage({
      model: model({ input: -1_000_000, output: -2_000_000, cache: { read: 0, write: 0 } }),
      usage: usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    })
    expect(result.cost).toBe(0)
  })

  test("normal usage still computes positive cost", () => {
    const result = Session.getUsage({
      model: model({ input: 3, output: 15, cache: { read: 0, write: 0 } }),
      usage: usage({ inputTokens: 1_000_000, outputTokens: 1_000_000, reasoningTokens: 0 }),
    })
    expect(result.cost).toBeCloseTo(3 + 15, 6)
    expect(result.tokens.input).toBe(1_000_000)
    expect(result.tokens.output).toBe(1_000_000)
  })

  test("cache read tokens are subtracted from billed input", () => {
    const result = Session.getUsage({
      model: model({ input: 3, output: 15, cache: { read: 0.3, write: 0 } }),
      usage: usage({ inputTokens: 1_000, cacheReadInputTokens: 400 }),
    })
    expect(result.tokens.input).toBe(600)
    expect(result.tokens.cache.read).toBe(400)
  })
})
