export * as Metrics from "./metrics.js"

import { Effect, Metric } from "effect"

// ── HTTP RED ──────────────────────────────────────────────────────────
// Per OpenTelemetry HTTP semantic conventions: histogram, unit seconds,
// attributes http.request.method / http.response.status_code.

export const httpRequestDuration = Metric.histogram("http.server.request.duration", {
  description: "Duration of HTTP server requests in seconds",
  boundaries: [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10],
})

// ── LLM Token Usage ───────────────────────────────────────────────────
// Per OpenTelemetry GenAI semantic conventions: histogram, unit {token},
// attributes gen_ai.token.type / gen_ai.provider.name / gen_ai.request.model.

export const llmTokenUsage = Metric.histogram("gen_ai.client.token.usage", {
  description: "Number of tokens used per LLM request",
  boundaries: [1, 4, 16, 64, 256, 1024, 4096, 16384, 65536],
})

// ── Sandbox Lifecycle Events ──────────────────────────────────────────
// Counter, attributes event ∈ {create, restore, oom, kill}.

export const sandboxEvents = Metric.counter("sandbox.lifecycle.count", {
  description: "Sandbox lifecycle events",
})

// ── Helpers ───────────────────────────────────────────────────────────

export function recordTokenUsage(
  tokens: { input: number; output: number },
  tags: { provider: string; model: string },
) {
  const entries = [
    ["input", tokens.input],
    ["output", tokens.output],
  ] as const
  // Skip zero counts: they would create empty time series for every
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

export function recordSandboxEvent(event: string) {
  return Metric.update(Metric.withAttributes(sandboxEvents, { event }), 1)
}