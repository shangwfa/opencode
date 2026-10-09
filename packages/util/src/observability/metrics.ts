import { Effect, Metric } from "effect"

// Metric names and attributes follow the OpenTelemetry semantic conventions
// agreed in docs/test-cases/observability/metrics-and-trace.md. The Effect
// `Metric` API does not declare `unit`, so units are convention only (they are
// not exported as OTLP metadata).

// HTTP server request duration, per OpenTelemetry HTTP semantic conventions:
// histogram, unit seconds, attributes http.request.method / http.response.status_code.
export const httpRequestDuration = Metric.histogram("http.server.request.duration", {
  description: "Duration of HTTP server requests in seconds",
  boundaries: [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10],
})

// LLM token usage, per OpenTelemetry GenAI semantic conventions: histogram of
// tokens used per request, unit {token}, attributes gen_ai.token.type /
// gen_ai.provider.name / gen_ai.request.model. Token dimensions collapse to
// input/output (reasoning and cache_* are not separate series).
export const llmTokenUsage = Metric.histogram("gen_ai.client.token.usage", {
  description: "Number of tokens used per request",
  boundaries: [1, 4, 16, 64, 256, 1024, 4096, 16384, 65536],
})

/** Lifecycle events counted by `sandbox.lifecycle.count`. */
export type SandboxLifecycleEvent = "create" | "restore" | "oom" | "kill"

// Sandbox lifecycle events. Health warnings (e.g. snapshot lag) stay out of
// this metric on purpose: they are not lifecycle transitions and already have
// durable session events.
export const sandboxLifecycle = Metric.counter("sandbox.lifecycle.count", {
  description: "Sandbox lifecycle events",
})

export function recordTokenUsage(
  tokens: { readonly input: number; readonly output: number },
  tags: { readonly provider: string; readonly model: string },
) {
  const entries = [
    ["input", tokens.input],
    ["output", tokens.output],
  ] as const
  // Skip zero counts: recording them would create empty time series for every
  // provider/model combination and inflate cardinality.
  return Effect.forEach(entries.filter(([, count]) => count > 0), ([type, count]) =>
    Metric.update(
      Metric.withAttributes(llmTokenUsage, {
        "gen_ai.token.type": type,
        "gen_ai.provider.name": tags.provider,
        "gen_ai.request.model": tags.model,
      }),
      count,
    ),
  )
}

export function recordSandboxEvent(event: SandboxLifecycleEvent) {
  return Metric.update(Metric.withAttributes(sandboxLifecycle, { event }), 1)
}

export * as Metrics from "./metrics.js"
