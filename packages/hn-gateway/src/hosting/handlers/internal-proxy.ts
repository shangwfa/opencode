/**
 * internal-proxy handler：/ai-infra-api*、/ai-chatbot* → 内部服务（原 proxyMap 正则匹配语义）。
 */
import { getInternalTargets } from "../../config/env.js"
import { logger } from "../../logger.js"
import type { HostingContext, HostingHandler } from "../context.js"

export const internalProxyHandler: HostingHandler = {
  name: "internal-proxy",
  canHandle: (ctx) => ctx.baseUrl.startsWith("/ai-infra-api") || ctx.baseUrl.startsWith("/ai-chatbot") || ctx.baseUrl === "/ai-infra-api" || ctx.baseUrl === "/ai-chatbot",

  async handle(ctx: HostingContext): Promise<Response | null> {
    const { c, baseUrl, domain, traceId } = ctx
    const targets = getInternalTargets()
    // 原实现：对 proxyMap 的 key 逐个做正则测试取首个命中
    const matched = Object.keys(targets).find((key) => new RegExp(key, "g").test(baseUrl))
    if (!matched) {
      logger.error({ span: "internal-proxy:notfound", traceId, domain, reqPath: baseUrl, msg: "Proxy project not found" })
      return c.text("Proxy project not found", 404)
    }

    // 原语义：目标地址拼接完整 baseUrl（含前缀）
    const targetUrl = `${targets[matched]}${baseUrl}`
    try {
      const method = c.req.method
      const body = method === "GET" || method === "HEAD" ? undefined : await c.req.arrayBuffer()
      const headers = new Headers(c.req.raw.headers)
      for (const name of ["host", "content-length", "connection"]) headers.delete(name)
      const response = await fetch(targetUrl, { method, headers, body, redirect: "manual" })
      const payload = await response.arrayBuffer()
      return new Response(payload, {
        status: response.status,
        headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
      })
    } catch (error) {
      logger.error({ span: "internal-proxy:error", traceId, domain, reqPath: baseUrl, msg: "内部代理异常", error: String(error) })
      return c.text("Bad Gateway", 502)
    }
  },
}
