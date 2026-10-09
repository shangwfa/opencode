import { describe, expect, test } from "bun:test"
import { Effect, Metric } from "effect"
import { Metrics } from "@opencode/util/observability/metrics"
import { currentTraceId } from "@opencode/util/observability/otlp"

type HistogramState = { count: number; sum: number }

const tokenAttrs = (type: string, provider: string, model: string) => ({
  "gen_ai.token.type": type,
  "gen_ai.provider.name": provider,
  "gen_ai.request.model": model,
})

// The registry service is injected per-run so tests never share metric state.
// The closing cast folds `Exclude<R, RegistryService>` — which TypeScript
// cannot statically reduce for a free type parameter — back to `never`.
const withRegistry = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(
    effect.pipe(Effect.provideService(Metric.MetricRegistry, new Map())) as Effect.Effect<A, E>,
  )

describe("metrics recording", () => {
  test("recordTokenUsage records input/output token histograms with GenAI attributes", async () => {
    const result = await withRegistry(
      Effect.gen(function* () {
        yield* Metrics.recordTokenUsage(
          { input: 100, output: 20 },
          { provider: "Yd-DeepSeek", model: "deepseek-v4-flash" },
        )
        const input = (yield* Metric.value(
          Metric.withAttributes(Metrics.llmTokenUsage, tokenAttrs("input", "Yd-DeepSeek", "deepseek-v4-flash")),
        )) as HistogramState
        const output = (yield* Metric.value(
          Metric.withAttributes(Metrics.llmTokenUsage, tokenAttrs("output", "Yd-DeepSeek", "deepseek-v4-flash")),
        )) as HistogramState
        return { inputCount: input.count, inputSum: input.sum, outputCount: output.count, outputSum: output.sum }
      }),
    )
    expect(result).toEqual({ inputCount: 1, inputSum: 100, outputCount: 1, outputSum: 20 })
  })

  test("recordTokenUsage isolates tags per provider and model", async () => {
    const result = await withRegistry(
      Effect.gen(function* () {
        yield* Metrics.recordTokenUsage({ input: 7, output: 0 }, { provider: "a", model: "m1" })
        yield* Metrics.recordTokenUsage({ input: 9, output: 0 }, { provider: "b", model: "m2" })
        const a = (yield* Metric.value(Metric.withAttributes(Metrics.llmTokenUsage, tokenAttrs("input", "a", "m1")))) as HistogramState
        const b = (yield* Metric.value(Metric.withAttributes(Metrics.llmTokenUsage, tokenAttrs("input", "b", "m2")))) as HistogramState
        return [a.sum, b.sum]
      }),
    )
    expect(result).toEqual([7, 9])
  })

  test("recordTokenUsage skips zero-count kinds to avoid empty series", async () => {
    const result = await withRegistry(
      Effect.gen(function* () {
        const before = (yield* Metric.snapshot).length
        yield* Metrics.recordTokenUsage({ input: 0, output: 0 }, { provider: "zero", model: "zero" })
        const after = (yield* Metric.snapshot).length
        yield* Metrics.recordTokenUsage({ input: 5, output: 0 }, { provider: "zero", model: "zero" })
        const input = (yield* Metric.value(
          Metric.withAttributes(Metrics.llmTokenUsage, tokenAttrs("input", "zero", "zero")),
        )) as HistogramState
        return { before, after, inputSum: input.sum }
      }),
    )
    expect(result.after).toBe(result.before)
    expect(result.inputSum).toBe(5)
  })

  test("recordSandboxEvent counts lifecycle events per event kind", async () => {
    const result = await withRegistry(
      Effect.gen(function* () {
        for (const event of ["create", "create", "restore", "oom", "kill"] as const) {
          yield* Metrics.recordSandboxEvent(event)
        }
        const counts = yield* Effect.forEach(["create", "restore", "oom", "kill"] as const, (event) =>
          Metric.value(Metric.withAttributes(Metrics.sandboxLifecycle, { event })).pipe(
            Effect.map((snapshot) => (snapshot as { count: number }).count),
          ),
        )
        return counts
      }),
    )
    expect(result).toEqual([2, 1, 1, 1])
  })
})

describe("currentTraceId", () => {
  const withEndpoint = (value: string | undefined, effect: Effect.Effect<string | undefined>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const previous = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
        if (value === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
        else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = value
        return yield* effect.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (previous === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
              else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = previous
            }),
          ),
        )
      }),
    )

  test("returns a 32-hex id inside a span when OTLP is configured", async () => {
    const id = await withEndpoint(
      "http://otel.test",
      Effect.withSpan("trace-id-probe")(currentTraceId),
    )
    expect(id).toMatch(/^[0-9a-f]{32}$/)
  })

  test("returns undefined without an active span", async () => {
    // A bare Effect.gen runs outside any span, so there is no trace context
    // to correlate even when OTLP is configured.
    const id = await withEndpoint("http://otel.test", currentTraceId)
    expect(id).toBeUndefined()
  })

  test("returns undefined when OTLP is not configured, even inside a span", async () => {
    const id = await withEndpoint(undefined, Effect.withSpan("trace-id-probe")(currentTraceId))
    expect(id).toBeUndefined()
  })
})
