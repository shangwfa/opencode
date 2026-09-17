import { describe, expect, test } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Effect, Layer, Metric } from "effect"
import { HttpClient, HttpClientRequest, HttpMiddleware, HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { httpMetricsMiddleware, recordHttpRequest } from "../../src/server/http-metrics"
import { disposeMiddleware } from "../../src/server/routes/instance/httpapi/lifecycle"
import { Metrics } from "../../src/observability/metrics"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

const route = HttpRouter.use((router) =>
  Effect.gen(function* () {
    yield* router.add("GET", "/ping", () => Effect.succeed(HttpServerResponse.text("pong")))
    yield* router.add("POST", "/echo", () => Effect.succeed(HttpServerResponse.text("ok")))
    yield* router.add("GET", "/missing", () => Effect.succeed(HttpServerResponse.text("nope", { status: 404 })))
    yield* router.add("GET", "/boom", () => Effect.die(new Error("boom")))
    yield* router.add("GET", "/fail", () => Effect.fail(new Error("nope")))
  }),
)

const layer = HttpRouter.serve(route, {
  middleware: httpMetricsMiddleware,
  disableLogger: true,
  disableListenLog: true,
}).pipe(Layer.provideMerge(NodeHttpServer.layerTest), Layer.provideMerge(NodeServices.layer))

// Mirrors the production wiring in server.ts, where metrics wraps the dispose
// middleware, to make sure the composition keeps working.
const combinedLayer = HttpRouter.serve(route, {
  middleware: HttpMiddleware.make((effect) => httpMetricsMiddleware(disposeMiddleware(effect))),
  disableLogger: true,
  disableListenLog: true,
}).pipe(Layer.provideMerge(NodeHttpServer.layerTest), Layer.provideMerge(NodeServices.layer))

function request(method: string, path: string) {
  const url = new URL(path, "http://localhost")
  return HttpClientRequest.fromWeb(new Request(url, { method })).pipe(
    HttpClientRequest.setUrl(url.pathname),
    HttpClient.execute,
  )
}

const state = (method: string, status: string) =>
  Metric.value(
    Metric.withAttributes(Metrics.httpRequestDuration, {
      "http.request.method": method,
      "http.response.status_code": status,
    }),
  )

const failureState = (method: string, status: string) =>
  Metric.value(
    Metric.withAttributes(Metrics.httpRequestDuration, {
      "http.request.method": method,
      "http.response.status_code": status,
      "error.type": "Error",
    }),
  )

describe("http metrics middleware", () => {
  it.live("records duration for a successful request", () =>
    Effect.gen(function* () {
      const before = (yield* state("GET", "200")).count

      const response = yield* request("GET", "/ping")
      expect(response.status).toBe(200)
      expect(yield* response.text).toBe("pong")

      const after = yield* state("GET", "200")
      expect(after.count).toBe(before + 1)
    }).pipe(Effect.provide(layer)),
  )

  it.live("tags requests by method and status code", () =>
    Effect.gen(function* () {
      const getBefore = (yield* state("GET", "200")).count
      const postBefore = (yield* state("POST", "200")).count

      expect((yield* request("POST", "/echo")).status).toBe(200)

      expect((yield* state("POST", "200")).count).toBe(postBefore + 1)
      expect((yield* state("GET", "200")).count).toBe(getBefore)
    }).pipe(Effect.provide(layer)),
  )

  it.live("records client error responses", () =>
    Effect.gen(function* () {
      const before = (yield* state("GET", "404")).count

      expect((yield* request("GET", "/missing")).status).toBe(404)

      expect((yield* state("GET", "404")).count).toBe(before + 1)
    }).pipe(Effect.provide(layer)),
  )

  it.live("records a defect as a 500 outcome with error.type", () =>
    Effect.gen(function* () {
      const before = (yield* failureState("GET", "500")).count

      yield* Effect.ignore(Effect.exit(request("GET", "/boom")))

      expect((yield* failureState("GET", "500")).count).toBe(before + 1)
    }).pipe(Effect.provide(layer)),
  )

  it.live("records a typed failure as a 500 outcome with error.type", () =>
    Effect.gen(function* () {
      const before = (yield* failureState("GET", "500")).count

      yield* Effect.ignore(Effect.exit(request("GET", "/fail")))

      expect((yield* failureState("GET", "500")).count).toBe(before + 1)
    }).pipe(Effect.provide(layer)),
  )

  it.live("still records metrics when composed with the dispose middleware", () =>
    Effect.gen(function* () {
      const before = (yield* state("GET", "200")).count

      expect((yield* request("GET", "/ping")).status).toBe(200)

      expect((yield* state("GET", "200")).count).toBe(before + 1)
    }).pipe(Effect.provide(combinedLayer)),
  )
})

test("recordHttpRequest records the duration histogram with semantic-convention attributes", async () => {
  const stored = await Effect.runPromise(
    Effect.gen(function* () {
      yield* recordHttpRequest({ method: "GET", statusCode: "418", durationSeconds: 0.042 })
      return yield* state("GET", "418")
    }),
  )
  expect(stored.count).toBe(1)
  expect(stored.sum).toBeCloseTo(0.042)
})
