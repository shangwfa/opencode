/**
 * redirect handler（原 redirect.handler 语义）：
 * /share/share → /embed/application/detail?{query}&container=browser
 * /client/appstore/detail → container=modal，302 跳转。
 */
import { logger } from "../../logger.js"
import type { HostingContext, HostingHandler } from "../context.js"

export const redirectHandler: HostingHandler = {
  name: "redirect",
  canHandle: (ctx) => ctx.baseUrl.startsWith("/share/share") || ctx.baseUrl.startsWith("/client/appstore/detail"),

  async handle(ctx: HostingContext): Promise<Response | null> {
    const { c, baseUrl, domain, traceId } = ctx
    const query = new URL(c.req.url).searchParams.toString()
    const container = baseUrl.startsWith("/share/share") ? "browser" : "modal"
    const redirectUrl = `/embed/application/detail?${query}${query ? "&" : ""}container=${container}`
    logger.info({ span: "redirect:success", traceId, domain, reqPath: baseUrl, msg: "Redirect request processed", redirectUrl, container })
    return c.redirect(redirectUrl, 302)
  },
}
