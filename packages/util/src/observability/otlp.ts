import { Effect, Layer, Option, Scope } from "effect"
import { OtlpLogger } from "effect/unstable/observability"
import { runID } from "./shared.js"

export interface Options {
  readonly endpoint?: string
  readonly headers?: string
}

export interface App {
  readonly client: string
  readonly version: string
  readonly channel: string
}

function parseHeaders(value?: string) {
  return value
    ? value.split(",").reduce(
        (acc, entry) => {
          const [key, ...value] = entry.split("=")
          acc[key] = value.join("=")
          return acc
        },
        {} as Record<string, string>,
      )
    : undefined
}

function resourceAttributes() {
  const value = process.env.OTEL_RESOURCE_ATTRIBUTES
  if (!value) return {}
  try {
    return Object.fromEntries(
      value.split(",").map((entry) => {
        const index = entry.indexOf("=")
        if (index < 1) throw new Error("Invalid OTEL_RESOURCE_ATTRIBUTES entry")
        return [decodeURIComponent(entry.slice(0, index)), decodeURIComponent(entry.slice(index + 1))]
      }),
    )
  } catch {
    return {}
  }
}

export function resource(app: App = { client: "opencode", version: "unknown", channel: "local" }): {
  serviceName: string
  serviceVersion: string
  attributes: Record<string, string>
} {
  return {
    serviceName: "opencode",
    serviceVersion: app.version,
    attributes: {
      ...resourceAttributes(),
      "deployment.environment.name": app.channel,
      "opencode.client": app.client,
      "opencode.run": runID(),
      "service.instance.id": runID(),
    },
  }
}

export function loggers(options: Options | undefined, app: App) {
  if (!options?.endpoint) return []
  return [
    OtlpLogger.make({
      url: `${options.endpoint}/v1/logs`,
      resource: resource(app),
      headers: parseHeaders(options.headers),
    }),
  ]
}

/**
 * Trace id of the current span, but only when OTLP export is configured: an id
 * written into audit storage must be resolvable at the collecting backend, and
 * a locally-generated id that is never exported would be misleading. Returns
 * `undefined` (audit NULL) when no span is active or OTLP is not configured.
 */
export const currentTraceId: Effect.Effect<string | undefined> = Effect.gen(function* () {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return undefined
  const span = yield* Effect.currentSpan.pipe(Effect.option)
  return Option.isSome(span) ? span.value.traceId : undefined
})

// Opt-in head sampling: `OTEL_TRACES_SAMPLER_ARG` as a ratio in [0, 1).
// Defaults to the SDK default (always-on) when unset.
function headSampler(
  sdk: typeof import("@opentelemetry/sdk-trace-base"),
): import("@opentelemetry/sdk-trace-base").Sampler | undefined {
  const ratio = Number(process.env.OTEL_TRACES_SAMPLER_ARG)
  if (!Number.isFinite(ratio) || ratio < 0 || ratio >= 1) return undefined
  return new sdk.ParentBasedSampler({ root: new sdk.TraceIdRatioBasedSampler(ratio) })
}

export const telemetryLayer = Effect.fnUntraced(function* (options: Options | undefined, app: App) {
  if (!options?.endpoint) return Layer.empty
  const [
      { layer },
      { OTLPTraceExporter },
      { OTLPMetricExporter },
      sdkBase,
      { AsyncLocalStorageContextManager },
      { context },
    ] =
    yield* Effect.all(
      [
        Effect.promise(() => import("@effect/opentelemetry/NodeSdk")),
        Effect.promise(() => import("@opentelemetry/exporter-trace-otlp-http")),
        Effect.promise(() => import("@opentelemetry/exporter-metrics-otlp-http")),
        Effect.promise(() => import("@opentelemetry/sdk-trace-base")),
        Effect.promise(() => import("@opentelemetry/context-async-hooks")),
        Effect.promise(() => import("@opentelemetry/api")),
      ],
      { concurrency: "unbounded" },
    )
  const sdkMetrics = yield* Effect.promise(() => import("@opentelemetry/sdk-metrics"))

  // The Effect Node SDK does not register a global context manager, but the AI SDK uses it to parent spans.
  const manager = new AsyncLocalStorageContextManager()
  manager.enable()
  context.setGlobalContextManager(manager)

  const sampler = headSampler(sdkBase)
  const tracing = layer(() => ({
    resource: resource(app),
    spanProcessor: new sdkBase.BatchSpanProcessor(
      new OTLPTraceExporter({
        url: `${options.endpoint}/v1/traces`,
        headers: parseHeaders(options.headers),
      }),
    ),
    ...(sampler ? { tracerConfig: { sampler } } : {}),
    metricReader: new sdkMetrics.PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({
        url: `${options.endpoint}/v1/metrics`,
        headers: parseHeaders(options.headers),
      }),
      exportIntervalMillis: 15_000,
    }),
  }))
  return Layer.effectContext(
    Effect.acquireRelease(Scope.make(), (scope, exit) => Scope.close(scope, exit).pipe(Effect.ignoreCause)).pipe(
      Effect.flatMap((scope) => Layer.buildWithScope(tracing, scope)),
    ),
  )
})

export * as Otlp from "./otlp.js"
