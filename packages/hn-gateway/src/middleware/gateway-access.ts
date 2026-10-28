/**
 * /gw-api 访问控制（原 gateway-api.handler 语义）：
 * 放行条件（满足其一）：domain 含 'front-gw'（API_DOMAIN）、路径含 'health'、localhost 访问；
 * 其余返回"无权访问"。
 */
import type { MiddlewareHandler } from "hono"

const API_DOMAIN = "front-gw"

export const gatewayApiAccessControl: MiddlewareHandler = async (c, next) => {
  const urlHost = new URL(c.req.url).hostname
  const domain = (c.req.header("domain") || c.req.header("host") || urlHost || "").toLowerCase()
  const host = (c.req.header("host") || urlHost || "").toLowerCase()
  const path = new URL(c.req.url).pathname
  const isLocalhost =
    domain.includes("localhost") ||
    domain.includes("127.0.0.1") ||
    domain.includes("::1") ||
    host.includes("localhost") ||
    host.includes("127.0.0.1") ||
    host.includes("::1")

  if (domain.includes(API_DOMAIN) || path.includes("health") || isLocalhost) {
    return next()
  }
  return c.text("无权访问")
}
