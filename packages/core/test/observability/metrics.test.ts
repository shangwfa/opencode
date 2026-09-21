import { describe, expect, test } from "bun:test"
import { Effect, Metric } from "effect"
import { Metrics } from "../../src/observability/metrics.js"

const tokenAttrs = (type: string, provider: string, model: string) => ({
  "gen_ai.token.type": type,
  "gen_ai.provider.name": provider,
  "gen_ai.request.model": model,
})

describe("metrics — semantic convention names", () => {
  test("httpRequestDuration follows OTel HTTP semconv", () => {
    expect(Metrics.httpRequestDuration.id).toBe("http.server.request.duration")
  })

  test("llmTokenUsage follows OTel GenAI semconv", () => {
    expect(Metrics.llmTokenUsage.id).toBe("gen_ai.client.token.usage")
  })

  test("sandboxEvents follows the configured convention", () => {
    expect(Metrics.sandboxEvents.id).toBe("sandbox.lifecycle.count")
  })
})

describe("metrics — token usage", () => {
  test("recordTokenUsage records input/output histograms with GenAI attributes", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Metrics.recordTokenUsage(
          { input: 100, output: 20 },
          { provider: "test-provider", model: "test-model" },
        )
        const input = yield* Metric.value(
          Metric.withAttributes(Metrics.llmTokenUsage, tokenAttrs("input", "test-provider", "test-model")),
        )
        const output = yield* Metric.value(
          Metric.withAttributes(Metrics.llmTokenUsage, tokenAttrs("output", "test-provider", "test-model")),
        )
        return { inputCount: input.count, inputSum: input.sum, outputCount: output.count, outputSum: output.sum }
      }),
    )
    expect(result).toEqual({ inputCount: 1, inputSum: 100, outputCount: 1, outputSum: 20 })
  })

  test("recordTokenUsage isolates tags per provider and model", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Metrics.recordTokenUsage({ input: 7, output: 0 }, { provider: "a", model: "m1" })
        yield* Metrics.recordTokenUsage({ input: 9, output: 0 }, { provider: "b", model: "m2" })
        const a = yield* Metric.value(Metric.withAttributes(Metrics.llmTokenUsage, tokenAttrs("input", "a", "m1")))
        const b = yield* Metric.value(Metric.withAttributes(Metrics.llmTokenUsage, tokenAttrs("input", "b", "m2")))
        return [a.sum, b.sum]
      }),
    )
    expect(result).toEqual([7, 9])
  })

  test("recordTokenUsage skips zero-count kinds to avoid empty series", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const before = (yield* Metric.snapshot).length
        yield* Metrics.recordTokenUsage({ input: 0, output: 0 }, { provider: "zero", model: "zero" })
        const after = (yield* Metric.snapshot).length
        yield* Metrics.recordTokenUsage({ input: 5, output: 0 }, { provider: "zero", model: "zero" })
        const input = yield* Metric.value(
          Metric.withAttributes(Metrics.llmTokenUsage, tokenAttrs("input", "zero", "zero")),
        )
        return { before, after, inputSum: input.sum }
      }),
    )
    expect(result.after).toBe(result.before)
    expect(result.inputSum).toBe(5)
  })
})

describe("metrics — sandbox events", () => {
  test("recordSandboxEvent counts each lifecycle event independently", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Metrics.recordSandboxEvent("create")
        yield* Metrics.recordSandboxEvent("create")
        yield* Metrics.recordSandboxEvent("oom")
        yield* Metrics.recordSandboxEvent("kill")
        const value = (event: string) => Metric.value(Metric.withAttributes(Metrics.sandboxEvents, { event }))
        return {
          create: (yield* value("create")).count,
          oom: (yield* value("oom")).count,
          kill: (yield* value("kill")).count,
        }
      }),
    )
    expect(result).toEqual({ create: 2, oom: 1, kill: 1 })
  })
})