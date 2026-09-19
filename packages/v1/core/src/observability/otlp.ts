import { Layer } from "effect"
import { OtlpLogger } from "effect/unstable/observability"
import { Flag } from "../flag/flag"
import { InstallationChannel, InstallationVersion } from "../installation/version"
import { runID } from "./shared"

const endpoint = Flag.OTEL_EXPORTER_OTLP_ENDPOINT

function parseHeaders(value: string | undefined): Record<string, string> | undefined {
  if (!value) return undefined
  return value.split(",").reduce(
    (acc, entry) => {
      const [key, ...rest] = entry.split("=")
      acc[key] = rest.join("=")
      return acc
    },
    {} as Record<string, string>,
  )
}

const headers = parseHeaders(Flag.OTEL_EXPORTER_OTLP_HEADERS)

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

export function resource(): { serviceName: string; serviceVersion: string; attributes: Record<string, string> } {
  return {
    serviceName: "opencode",
    serviceVersion: InstallationVersion,
    attributes: {
      ...resourceAttributes(),
      "deployment.environment.name": InstallationChannel,
      "opencode.client": Flag.OPENCODE_CLIENT,
      "opencode.run": runID,
      "service.instance.id": runID,
    },
  }
}

export function loggers(options?: { endpoint?: string; headers?: Record<string, string> }) {
  const url = options?.endpoint ?? endpoint
  if (!url) return []
  return [OtlpLogger.make({ url: `${url}/v1/logs`, resource: resource(), headers: options?.headers ?? headers })]
}

export async function observabilityLayer(options?: {
  endpoint?: string
  headers?: Record<string, string>
  metricExportIntervalMillis?: number
}) {
  const url = options?.endpoint ?? endpoint
  if (!url) return Layer.empty
  const exporterHeaders = options?.headers ?? headers
  const NodeSdk = await import("@effect/opentelemetry/NodeSdk")
  const OTLP = await import("@opentelemetry/exporter-trace-otlp-http")
  const OtlpMetrics = await import("@opentelemetry/exporter-metrics-otlp-http")
  const SdkBase = await import("@opentelemetry/sdk-trace-base")
  const SdkMetrics = await import("@opentelemetry/sdk-metrics")
  const { AsyncLocalStorageContextManager } = await import("@opentelemetry/context-async-hooks")
  const { context } = await import("@opentelemetry/api")

  // The Effect Node SDK does not register a global context manager, but the AI SDK uses it to parent spans.
  const manager = new AsyncLocalStorageContextManager()
  manager.enable()
  context.setGlobalContextManager(manager)

  // Opt-in head sampling: `OTEL_TRACES_SAMPLER_ARG` as a ratio in [0, 1).
  // Defaults to unsampled (always-on) via the SDK default when unset.
  const sampleRatio = Number(process.env.OTEL_TRACES_SAMPLER_ARG)
  const sampled = Number.isFinite(sampleRatio) && sampleRatio >= 0 && sampleRatio < 1

  return NodeSdk.layer(() => ({
    resource: resource(),
    spanProcessor: new SdkBase.BatchSpanProcessor(
      new OTLP.OTLPTraceExporter({
        url: `${url}/v1/traces`,
        headers: exporterHeaders,
      }),
    ),
    ...(sampled
      ? {
          tracerConfig: {
            sampler: new SdkBase.ParentBasedSampler({ root: new SdkBase.TraceIdRatioBasedSampler(sampleRatio) }),
          },
        }
      : {}),
    metricReader: new SdkMetrics.PeriodicExportingMetricReader({
      exporter: new OtlpMetrics.OTLPMetricExporter({
        url: `${url}/v1/metrics`,
        headers: exporterHeaders,
      }),
      exportIntervalMillis: options?.metricExportIntervalMillis ?? 15_000,
    }),
  }))
}

export * as Otlp from "./otlp"
