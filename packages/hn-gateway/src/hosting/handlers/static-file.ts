/**
 * static-file handler：有扩展名的非 HTML 请求回源 COS（原 static-file.handler 语义）。
 * 文件 URL = {app.url}/{version||header.version}{baseUrl}。
 */
import { getDefaultDomain } from "../../config/env.js"
import { appService } from "../../domains/apps/service.js"
import { logger } from "../../logger.js"
import { isFileRequest, lookupMimeType } from "../utils/file.js"
import type { HostingContext, HostingHandler } from "../context.js"

export const staticFileHandler: HostingHandler = {
  name: "static-file",
  canHandle: (ctx) => isFileRequest(ctx.baseUrl),

  async handle(ctx: HostingContext): Promise<Response | null> {
    const { c, baseUrl, domain, traceId, version } = ctx

    try {
      const baseRoute = baseUrl.split("/")[1] ?? ""
      const app = await appService.getAppByDomain(domain || getDefaultDomain(), baseRoute)
      if (!app) {
        logger.error({ span: "static-file:notfound", traceId, domain, reqPath: baseUrl, msg: "App configuration not found for static file", baseRoute })
        return c.text("App not found", 404)
      }

      const selectedVersion = version || String(app.version ?? "")
      const fileUrl = `${String(app.url)}/${selectedVersion}${baseUrl}`
      const startTime = Date.now()
      const response = await fetch(fileUrl)
      const duration = Date.now() - startTime

      if (!response.ok) {
        logger.error({ span: "static-file:error", traceId, domain, reqPath: baseUrl, msg: "Failed to serve static file", fileUrl, status: response.status })
        return c.text("Internal Server Error", 500)
      }

      const dot = baseUrl.lastIndexOf(".")
      const contentType = lookupMimeType(dot >= 0 ? baseUrl.slice(dot) : "")
      const payload = await response.arrayBuffer()
      logger.info({ span: "static-file:success", traceId, domain, reqPath: baseUrl, msg: "Static file served successfully", fileUrl, contentType, fileSize: payload.byteLength, duration })
      return new Response(payload, { status: 200, headers: { "content-type": contentType } })
    } catch (error) {
      logger.error({ span: "static-file:error", traceId, domain, reqPath: baseUrl, msg: "Failed to serve static file", error: String(error) })
      return c.text("Internal Server Error", 500)
    }
  },
}
