/**
 * Prometheus 指标（对齐原 @xybot/prom-metrics 能力面）：
 * - 默认进程指标 + HTTP 请求时长/计数 + 异常计数 + outbound（代理/回源）时长
 * - /metrics 端点；GATEWAY_METRICS=off 整体关闭
 */
import { Counter, Histogram, Registry, collectDefaultMetrics } from "prom-client"
import type { MiddlewareHandler } from "hono"
import { isMetricsEnabled } from "./config/env.js"

const registry = new Registry()

collectDefaultMetrics({ register: registry, prefix: "gateway_" })

export const httpRequestDuration = new Histogram({
  name: "gateway_http_request_duration_seconds",
  help: "HTTP 请求耗时",
  labelNames: ["method", "path", "status"] as const,
  buckets: [0.005, 0.01, 0.05, 0.1, 0.3, 0.5, 1, 3, 5, 10],
  registers: [registry],
})

export const httpExceptionCounter = new Counter({
  name: "gateway_http_exceptions_total",
  help: "HTTP 处理异常次数",
  labelNames: ["path"] as const,
  registers: [registry],
})

export const outboundDuration = new Histogram({
  name: "gateway_outbound_request_duration_seconds",
  help: "出站请求耗时（api-proxy/静态回源等）",
  labelNames: ["system", "operation", "status"] as const,
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 3, 5, 10],
  registers: [registry],
})

/** 指标采集中间件（hosting 链之外，最先挂载） */
export const metricsMiddleware: MiddlewareHandler = async (c, next) => {
  if (!isMetricsEnabled()) return next()
  const start = Date.now()
  try {
    await next()
  } catch (error) {
    httpExceptionCounter.inc({ path: c.req.path })
    throw error
  } finally {
    httpRequestDuration.observe(
      { method: c.req.method, path: c.req.path, status: String(c.res.status) },
      (Date.now() - start) / 1000,
    )
  }
}

/** outbound 计时工具：对齐原 OutboundMetricsService.track 语义 */
export async function trackOutbound<T>(
  labels: { system: string; operation: string },
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now()
  try {
    return await fn()
  } finally {
    if (isMetricsEnabled()) {
      outboundDuration.observe(labels, (Date.now() - start) / 1000)
    }
  }
}

export async function renderMetrics(): Promise<string> {
  return registry.metrics()
}

export const metricsRegistry = registry
