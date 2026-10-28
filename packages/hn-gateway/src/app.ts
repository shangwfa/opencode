/**
 * hn-gateway HTTP 应用装配（hono，模式同 packages/knowledge/app.ts）。
 *
 * createGatewayApp() 返回可独立运行、也可挂载到其它 hono 服务的子应用：
 *   /health    健康检查（PG 连通性）
 *   /metrics   Prometheus 指标（GATEWAY_METRICS=off 关闭）
 *   （hosting 责任链与 /gw-api/*、/report-api/*、/app-api/* 业务域在后续阶段挂载，见 DESIGN.md §5）
 */
import { Hono } from "hono"
import { cors } from "hono/cors"
import { trimTrailingSlash } from "hono/trailing-slash"
import { isMetricsEnabled } from "./config/env.js"
import { metricsMiddleware, renderMetrics } from "./metrics.js"
import { traceMiddleware } from "./hosting/trace.js"
import { logger } from "./logger.js"
import { healthApp } from "./domains/health/index.js"
import { platformApp, appsApp } from "./domains/platform/index.js"
import { microappsApp } from "./domains/microapps/index.js"
import { apApp } from "./domains/ap/index.js"
import { webhookApp } from "./domains/webhook/index.js"
import { uploadApp } from "./domains/upload/index.js"
import { gitlabApp } from "./domains/gitlab/index.js"
import { pipelinesApp } from "./domains/pipelines/index.js"
import { reportApp } from "./domains/report/index.js"
import { hostingChain } from "./hosting/middleware.js"
import { responseFormatter } from "./middleware/response-formatter.js"
import { gatewayApiAccessControl } from "./middleware/gateway-access.js"

/** 管理面子应用（原 gateway-api handler 承接的 /gw-api/* 路由） */
export const gatewayApi = new Hono()
  .use("*", gatewayApiAccessControl) // 域名白名单（原 gateway-api localhost/API_DOMAIN 检查）
  .use("*", responseFormatter) // 原全局 ResponseFormatterInterceptor 语义
  .route("/", platformApp) // /gw-api/platform*、/gw-api/private-info、/gw-api/nacos/*、/gw-api/backend-gray/*
  .route("/apps", appsApp) // /gw-api/apps/*
  .route("/microapps", microappsApp) // /gw-api/microapps*
  .route("/ap", apApp) // /gw-api/ap/*
  .route("/webhook", webhookApp) // /gw-api/webhook/*
  .route("/upload", uploadApp) // /gw-api/upload/*
  .route("/gitlab", gitlabApp) // /gw-api/gitlab/*
  .route("/pipelines", pipelinesApp) // /gw-api/pipelines*

// 未匹配的 /gw-api 路径返回 Nest 风格 404（原 Nest 路由系统语义），不落入 hosting 兜底链
gatewayApi.notFound((c) =>
  c.json(
    {
      statusCode: 404,
      timestamp: new Date().toISOString(),
      url: `${c.req.method} ${new URL(c.req.url).pathname}`,
      message: { statusCode: 404, message: `Cannot ${c.req.method} ${c.req.path}` },
    },
    404,
  ),
)

/** API 子应用：各业务域按域前缀挂载 */
export const api = new Hono()
  .use("*", trimTrailingSlash()) // 尾斜杠归一（Express/Nest 原生语义）
  .use("*", cors())
  .use("*", traceMiddleware)
  .use("*", metricsMiddleware)
  .route("/health", healthApp)
  .route("/gw-api", gatewayApi)
  .route("/report-api", reportApp)

export interface GatewayAppOptions {
  /** 路由前缀，默认 ''（网关按原始路径服务前端，默认不加前缀） */
  basePath?: string
}

export async function createGatewayApp(options: GatewayAppOptions = {}): Promise<Hono> {
  const app = new Hono()

  // 非 GET 尾斜杠归一：hono 的 trimTrailingSlash 仅处理 GET 404，
  // 这里对非 GET 的尾斜杠请求内部重派发（Express/Nest 对两种形式等价的语义），
  // 避免未被路由匹配的请求落入 hosting 兜底链。
  app.use("*", async (c, next) => {
    const path = c.req.path
    const method = c.req.method
    if (path !== "/" && path.endsWith("/") && method !== "GET" && method !== "HEAD") {
      const url = new URL(c.req.url)
      url.pathname = path.replace(/\/+$/, "")
      const headers = new Headers(c.req.raw.headers)
      headers.delete("content-length")
      const response = await app.fetch(
        new Request(url.toString(), { method, headers, body: c.req.raw.body, duplex: "half" } as RequestInit),
      )
      c.res = response
      return
    }
    await next()
  })

  // 全局错误处理：对齐原 HttpExceptionFilter 响应形态
  app.onError((error, c) => {
    const status = (error as { statusCode?: number })?.statusCode ?? 500
    const message = error instanceof Error ? error.message : String(error)
    logger.error({
      span: "http:error",
      traceId: c.req.header("x-trace-id"),
      reqPath: new URL(c.req.url).pathname,
      msg: "请求处理异常",
      error: message,
    })
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, "0")
    const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
    return c.json(
      {
        statusCode: status,
        timestamp,
        url: `${c.req.method} ${new URL(c.req.url).pathname}`,
        message,
      },
      status as 500,
    )
  })

  app.notFound((c) =>
    c.json(
      {
        statusCode: 404,
        timestamp: new Date().toISOString(),
        url: `${c.req.method} ${new URL(c.req.url).pathname}`,
        message: "Not Found",
      },
      404,
    ),
  )

  if (options.basePath) {
    app.route(options.basePath, api)
  } else {
    app.route("/", api)
  }

  // /metrics 独立于 api（原网关将其排除在 hosting 链外）
  if (isMetricsEnabled()) {
    app.get("/metrics", async (c) => c.text(await renderMetrics(), 200, { "Content-Type": "text/plain; version=0.0.4" }))
  }

  // hosting 责任链最后注册：仅承接未被路由声明的请求（静态/HTML/代理/SSO/重定向等）
  app.use("*", hostingChain)

  return app
}

/** RPC 客户端类型：`hc<GatewayAppType>('http://host')` */
export type GatewayAppType = typeof api
