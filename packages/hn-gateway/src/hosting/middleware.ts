/**
 * hosting 责任链（原 AppHostingMiddleware 责任链的一比一迁移）。
 *
 * 顺序：api-proxy → internal-proxy → app-api-info → static-file → sso → redirect → app-hosting(兜底)。
 * /gw-api/*、/health、/report-api 由已挂载路由承接（等价原 gateway-api/report handler 的 next() 语义）。
 * handler 返回 Response 即短路；返回 null 放行（等价原 shouldCallNext → next()）。
 */
import type { MiddlewareHandler } from "hono"
import { getTraceContext } from "./trace.js"
import type { HostingContext, HostingHandler } from "./context.js"
import { apiProxyHandler } from "./handlers/api-proxy.js"
import { internalProxyHandler } from "./handlers/internal-proxy.js"
import { appApiInfoHandler } from "./handlers/app-api-info.js"
import { staticFileHandler } from "./handlers/static-file.js"
import { ssoHandler } from "./handlers/sso.js"
import { redirectHandler } from "./handlers/redirect.js"
import { appHostingHandler } from "./handlers/app-hosting.js"

export const hostingHandlers: HostingHandler[] = [
  apiProxyHandler,
  internalProxyHandler,
  appApiInfoHandler,
  staticFileHandler,
  ssoHandler,
  redirectHandler,
  appHostingHandler,
]

export const hostingChain: MiddlewareHandler = async (c, next) => {
  // /metrics 与 /socket.io 绕过责任链（原 exclude 语义）
  const path = new URL(c.req.url).pathname
  if (path === "/metrics" || path.startsWith("/socket.io")) return next()

  // 控制器前缀未被路由承接（如 /gw-api 未知路径）→ Nest 风格 404，
  // 不落入 hosting 兜底（原 Nest 路由系统 404 语义）
  if (path.startsWith("/gw-api") || path.startsWith("/report-api")) {
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, "0")
    return c.json(
      {
        statusCode: 404,
        timestamp: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
        url: `${c.req.method} ${path}`,
        message: { statusCode: 404, message: `Cannot ${c.req.method} ${path}` },
      },
      404,
    )
  }

  const trace = getTraceContext()
  const ctx: HostingContext = {
    c,
    domain: trace?.domain ?? "",
    baseUrl: path,
    traceId: trace?.traceId ?? "",
    version: trace?.version,
    enterpriseUuid: trace?.enterpriseUuid ?? "",
    uuid: trace?.uuid ?? "",
  }

  for (const handler of hostingHandlers) {
    if (!handler.canHandle(ctx)) continue
    const response = await handler.handle(ctx)
    if (response) return response
    break // 命中但未接管（放行语义），交还后续路由/404
  }
  return next()
}
