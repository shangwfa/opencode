import { Cause, Clock, Effect, Exit, Metric } from "effect"
import { HttpMiddleware, HttpServerRequest } from "effect/unstable/http"
import { Metrics } from "@opencode/util/observability/metrics"

function recordHttpRequest(input: {
  method: string
  statusCode: string
  durationSeconds: number
  errorType?: string
}) {
  const attributes: Record<string, string> = {
    "http.request.method": input.method,
    "http.response.status_code": input.statusCode,
  }
  if (input.errorType !== undefined) attributes["error.type"] = input.errorType
  return Metric.update(
    Metric.withAttributes(Metrics.httpRequestDuration, attributes),
    input.durationSeconds,
  )
}

function errorType(cause: Cause.Cause<unknown>) {
  const error = Cause.squash(cause)
  if (error && typeof error === "object" && "_tag" in error) return String((error as { _tag: unknown })._tag)
  return error instanceof Error ? error.name : "Error"
}

// Records RED metrics for every served request, including auth failures and
// readiness rejections. `Effect.onExit` keeps the response and failure
// semantics untouched while still observing errors: failures collapse to a
// `500` status code plus `error.type`, matching the T62 conventions.
export const httpMetrics = HttpMiddleware.make((app) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const startedAt = yield* Clock.currentTimeMillis
    return yield* Effect.onExit(app, (exit) =>
      Effect.gen(function* () {
        const durationSeconds = ((yield* Clock.currentTimeMillis) - startedAt) / 1000
        return yield* recordHttpRequest(
          Exit.isSuccess(exit)
            ? { method: request.method, statusCode: String(exit.value.status), durationSeconds }
            : {
                method: request.method,
                statusCode: "500",
                durationSeconds,
                errorType: errorType(exit.cause),
              },
        )
      }),
    )
  }),
)
