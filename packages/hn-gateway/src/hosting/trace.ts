/**
 * 请求上下文：AsyncLocalStorage 贯穿 traceId/domain/reqPath（对齐原网关 HandlerContext），
 * 响应头写 X-Trace-ID（原 SkyWalking traceId 语义的等价替代）。
 */
import { AsyncLocalStorage } from "node:async_hooks"
import type { MiddlewareHandler } from "hono"
import { randomUUID } from "node:crypto"

export interface TraceContext {
  traceId: string
  domain: string
  reqPath: string
  /** 原网关从 cookie 解析的企业/用户标识，handler 层复用 */
  enterpriseUuid: string
  uuid: string
  /** 请求头 version（测试用版本覆盖，灰度策略最高优先级） */
  version?: string
}

const als = new AsyncLocalStorage<TraceContext>()

export function getTraceContext(): TraceContext | undefined {
  return als.getStore()
}

function parseCookies(cookieHeader: string): Record<string, string> {
  const map: Record<string, string> = {}
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=")
    if (idx === -1) continue
    const key = part.slice(0, idx).trim()
    const value = part.slice(idx + 1).trim()
    if (key) map[key] = decodeURIComponent(value)
  }
  return map
}

/** 全局 trace 中间件：注入上下文 + X-Trace-ID 响应头 */
export const traceMiddleware: MiddlewareHandler = async (c, next) => {
  const cookies = parseCookies(c.req.header("cookie") || "")
  const context: TraceContext = {
    traceId: randomUUID(),
    domain: (c.req.header("domain") || c.req.header("host") || "").toLowerCase(),
    reqPath: new URL(c.req.url).pathname,
    enterpriseUuid: cookies["enterpriseUuid"] || "",
    uuid: cookies["uuid"] || "",
    version: c.req.header("version"),
  }
  c.header("X-Trace-ID", context.traceId)
  await als.run(context, next)
}
