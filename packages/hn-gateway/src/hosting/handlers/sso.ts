/**
 * sso handler：/exchange/sso/token → 内联 SSO 中转页（原 sso.handler 语义，页面原样搬运）。
 */
import { logger } from "../../logger.js"
import { SSO_HTML_CONTENT } from "../sso-page.js"
import type { HostingContext, HostingHandler } from "../context.js"

export const ssoHandler: HostingHandler = {
  name: "sso",
  canHandle: (ctx) => ctx.baseUrl.startsWith("/exchange/sso/token") || ctx.baseUrl === "/exchange/sso/token",

  async handle(ctx: HostingContext): Promise<Response | null> {
    const { c, baseUrl, domain, traceId } = ctx
    logger.info({ span: "sso:success", traceId, domain, reqPath: baseUrl, msg: "SSO token exchange request processed" })
    return c.html(SSO_HTML_CONTENT)
  },
}
