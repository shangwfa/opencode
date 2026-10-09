import { describe, expect, test } from "bun:test"
import { Effect, Exit, Metric, Scope } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { httpMetrics } from "../src/middleware/http-metrics"
import { Metrics } from "@opencode/util/observability/metrics"

const durationOf = (attrs: Record<string, string>) =>
  Metric.value(Metric.withAttributes(Metrics.httpRequestDuration, attrs))

const throughMiddleware = <E>(
  app: Effect.Effect<HttpServerResponse.HttpServerResponse, E>,
  method: string,
) =>
  Effect.gen(function* () {
    yield* Scope.Scope
    return yield* httpMetrics(app).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(new Request("http://localhost/api/test", { method })),
      ),
    )
  })

describe("httpMetrics middleware", () => {
  test("records method and status for a successful response", async () => {
    const registry = new Map()
    await Effect.runPromise(
      throughMiddleware(Effect.succeed(HttpServerResponse.empty({ status: 200 })), "GET").pipe(
        Effect.scoped,
        Effect.provideService(Metric.MetricRegistry, registry),
      ),
    )
    const state = await Effect.runPromise(
      durationOf({ "http.request.method": "GET", "http.response.status_code": "200" }).pipe(
        Effect.provideService(Metric.MetricRegistry, registry),
      ),
    )
    expect(state.count).toBe(1)
    expect(state.sum).toBeGreaterThanOrEqual(0)
  })

  test("collapses tagged failures to 500 with error.type", async () => {
    const registry = new Map()
    const failure = new (class PermissionDenied {
      readonly _tag = "PermissionDenied"
    })()
    const exit = await Effect.runPromise(
      throughMiddleware(Effect.fail(failure), "POST").pipe(
        Effect.exit,
        Effect.scoped,
        Effect.provideService(Metric.MetricRegistry, registry),
      ),
    )
    expect(exit).toEqual(Exit.fail(failure))
    const state = await Effect.runPromise(
      durationOf({
        "http.request.method": "POST",
        "http.response.status_code": "500",
        "error.type": "PermissionDenied",
      }).pipe(Effect.provideService(Metric.MetricRegistry, registry)),
    )
    expect(state.count).toBe(1)
  })

  test("uses the error name for plain Error failures", async () => {
    const registry = new Map()
    const failure = new Error("boom")
    await Effect.runPromise(
      throughMiddleware(Effect.fail(failure), "GET").pipe(
        Effect.exit,
        Effect.scoped,
        Effect.provideService(Metric.MetricRegistry, registry),
      ),
    )
    const state = await Effect.runPromise(
      durationOf({
        "http.request.method": "GET",
        "http.response.status_code": "500",
        "error.type": "Error",
      }).pipe(Effect.provideService(Metric.MetricRegistry, registry)),
    )
    expect(state.count).toBe(1)
  })
})
