/**
 * app-api-info handler：/app-api/info 返回宿主应用信息（原 app-api-info.handler 语义）。
 * 应用路径取 baseurl/base-url 请求头（与 app-hosting 相同的 community 特例匹配）。
 */
import { getDefaultDomain } from "../../config/env.js"
import { appService } from "../../domains/apps/service.js"
import { logger } from "../../logger.js"
import { strategyManager } from "../strategies/index.js"
import type { HostingContext, HostingHandler } from "../context.js"

/** 与 app-hosting 一致的首段路径解析（含 community 特例） */
export function resolveBaseRoute(pathOrUrl: string): string {
  let baseRoute = pathOrUrl.split("/")[1] ?? ""
  if (pathOrUrl.includes("community/assistant")) baseRoute = "community/assistant"
  else if (pathOrUrl.includes("community/rpa-flow")) baseRoute = "community/rpa-flow"
  return baseRoute
}

export const appApiInfoHandler: HostingHandler = {
  name: "app-api-info",
  canHandle: (ctx) => ctx.baseUrl === "/app-api/info",

  async handle(ctx: HostingContext): Promise<Response | null> {
    const { c, domain, traceId } = ctx
    const baseUrlFromHeader = c.req.header("baseurl") || c.req.header("base-url") || ""
    const path = baseUrlFromHeader.startsWith("/") ? baseUrlFromHeader.split("/")[1] ?? "" : baseUrlFromHeader.split("/")[0] ?? ""
    const baseRoute = path.includes("community/") ? resolveBaseRoute(baseUrlFromHeader) : path

    const app = await appService.getAppByDomain(domain || getDefaultDomain(), baseRoute)
    if (!app) {
      // 原语义：未匹配到应用时返回空对象
      return c.json({})
    }
    const selectedVersion = await strategyManager.selectVersion({
      c,
      req: c.req.raw,
      app,
      domain,
      baseUrl: baseUrlFromHeader,
      traceId,
    })
    logger.info({ span: "app-api:info:success", traceId, domain, reqPath: baseUrlFromHeader, msg: `App found: ${String(app.name)} (${String(app.appId)})`, appId: String(app.appId), version: selectedVersion })
    return c.json({
      name: String(app.name ?? ""),
      id: String(app.appId ?? ""),
      version: selectedVersion || "",
    })
  },
}
