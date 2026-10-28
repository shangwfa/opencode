/**
 * api-proxy handler：/api*、/oauth/token → API 网关（原 api-proxy.handler 语义）。
 * 过滤 hop 头、业务码日志、业务错误触发飞书告警、outbound 指标。
 */
import { getApiGatewayTarget } from "../../config/env.js"
import { appService } from "../../domains/apps/service.js"
import { logger } from "../../logger.js"
import { trackOutbound } from "../../metrics.js"
import { sendFeishuAlert } from "../../integrations/feishu-alert.js"
import type { HostingContext, HostingHandler } from "../context.js"

const HOP_HEADERS = ["host", "content-length", "connection", "keep-alive", "transfer-encoding", "upgrade"]

function filterHeaders(req: Request): Headers {
  const headers = new Headers(req.headers)
  for (const name of HOP_HEADERS) headers.delete(name)
  for (const name of ["sec-fetch-site", "Sec-Fetch-Site"]) headers.delete(name)
  return headers
}

export const apiProxyHandler: HostingHandler = {
  name: "api-proxy",
  canHandle: (ctx) => ctx.baseUrl.startsWith("/api") || ctx.baseUrl.startsWith("/oauth/token"),

  async handle(ctx: HostingContext): Promise<Response | null> {
    const { c, baseUrl, domain, traceId } = ctx
    const method = c.req.method
    const page = c.req.header("referer") || ""
    // 原 axios params: query 语义——查询串完整透传
    const search = new URL(c.req.url).search
    const targetUrl = `${getApiGatewayTarget()}${baseUrl}${search}`

    try {
      const body = method === "GET" || method === "HEAD" ? undefined : await c.req.arrayBuffer()
      const response = await trackOutbound({ system: "api-gateway", operation: method }, () =>
        fetch(targetUrl, { method, headers: filterHeaders(c.req.raw), body, redirect: "manual" }),
      )
      const payload = await response.arrayBuffer()
      const durationLabel = response.headers.get("x-response-cost") ?? ""

      let businessCode: unknown
      let businessMsg: unknown
      try {
        const parsed = JSON.parse(new TextDecoder().decode(payload)) as { code?: unknown; msg?: unknown; success?: unknown }
        businessCode = parsed?.code
        businessMsg = parsed?.msg
      } catch {
        // 非 JSON 响应按透传处理
      }

      const baseRoute = baseUrl.split("/")[1] ?? ""
      const app = await appService.getAppByDomain(domain, baseRoute)

      if (response.status !== 200) {
        logger.error({ span: "api:error:http", traceId, domain, reqPath: baseUrl, msg: "HTTP 错误", status: response.status, page })
      } else if (businessCode === 200 || businessCode === undefined) {
        logger.info({ span: "api:success", traceId, domain, reqPath: baseUrl, msg: "接口调用成功", page })
      } else {
        const webhook = (app?.env as { ERROR_WEB_HOOK?: string } | undefined)?.ERROR_WEB_HOOK
        if (typeof webhook === "string" && webhook) {
          await sendFeishuAlert({
            webhook,
            appName: String(app?.name ?? ""),
            method,
            targetUrl,
            page,
            traceId,
            errorCode: String(businessCode ?? ""),
            errorMsg: String(businessMsg ?? ""),
          })
        }
        logger.error({ span: "api:error:business", traceId, domain, reqPath: baseUrl, msg: "业务错误", businessCode, businessMsg, page })
      }

      return new Response(payload, {
        status: response.status,
        headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
      })
    } catch (error) {
      logger.error({ span: "api:error:exception", traceId, domain, reqPath: baseUrl, msg: "API 代理异常", error: String(error) })
      return c.text("Bad Gateway", 502)
    }
  },
}
