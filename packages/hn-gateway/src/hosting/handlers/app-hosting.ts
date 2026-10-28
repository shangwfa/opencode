/**
 * app-hosting 兜底 handler（原 app-hosting.handler 语义，微前端宿主核心）：
 * app.proxy → 整机透传；否则灰度选版本 → 回源入口 HTML → cheerio 注入 window.YD
 * （env/version/MICRO_APPS，无 locale——多语言已裁剪）→ LRU 缓存（key 含 app 配置指纹）。
 */
import { createHash } from "node:crypto"
import * as cheerio from "cheerio"
import { getCndDomain, getDefaultDomain } from "../../config/env.js"
import { appService, type IApp } from "../../domains/apps/service.js"
import { logger } from "../../logger.js"
import { htmlCache } from "../html-cache.js"
import { refererStatLog } from "../utils/analytics.js"
import { strategyManager } from "../strategies/index.js"
import type { HostingContext, HostingHandler } from "../context.js"
import { resolveBaseRoute } from "./app-api-info.js"

/** app 配置指纹（排除 publishList）：配置一变缓存 key 即变，天然失效（原 getAppCacheFingerprint） */
export function getAppCacheFingerprint(app: IApp): string {
  const withoutPublishList = Object.fromEntries(Object.entries(app).filter(([k]) => k !== "publishList"))
  try {
    return createHash("sha256").update(JSON.stringify(withoutPublishList)).digest("hex").slice(0, 24)
  } catch {
    return String(app.version ?? "")
  }
}

export const appHostingHandler: HostingHandler = {
  name: "app-hosting",
  canHandle: () => true,

  async handle(ctx: HostingContext): Promise<Response | null> {
    const { c, baseUrl, domain, traceId } = ctx
    refererStatLog(domain, c.req.raw)

    const baseRoute = resolveBaseRoute(baseUrl)
    const app = await appService.getAppByDomain(domain || getDefaultDomain(), baseRoute)
    if (!app) {
      logger.error({ span: "app:notfound", traceId, domain, reqPath: baseUrl, msg: "访问的应用不存在" })
      return c.text("访问的应用不存在")
    }

    // 应用级整机代理（原 app.proxy → http-proxy.web，路径原样保留）
    const proxy = app.proxy as { target?: string } | undefined
    if (proxy?.target) {
      try {
        const method = c.req.method
        const body = method === "GET" || method === "HEAD" ? undefined : await c.req.arrayBuffer()
        const headers = new Headers(c.req.raw.headers)
        headers.delete("host")
        headers.delete("content-length")
        const response = await fetch(`${proxy.target}${baseUrl}`, { method, headers, body, redirect: "manual" })
        const payload = await response.arrayBuffer()
        return new Response(payload, {
          status: response.status,
          headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
        })
      } catch (error) {
        logger.error({ span: "app:proxy:error", traceId, domain, reqPath: baseUrl, msg: "应用代理异常", error: String(error) })
        return c.text("Bad Gateway", 502)
      }
    }

    const selectedVersion = await strategyManager.selectVersion({ c, req: c.req.raw, app, domain, baseUrl, traceId })
    const url = String(app.url ?? "")
    const type = String(app.type ?? "")
    const siteUrl = type === "ssg" && baseUrl !== "/" ? `${url}/${selectedVersion}${baseUrl}` : `${url}/${selectedVersion}`
    const html = await modifyHtml({ siteUrl, app, selectedVersion, traceId, domain, basePath: baseUrl })
    return c.html(html)
  },
}

interface ModifyHtmlInput {
  siteUrl: string
  app: IApp
  selectedVersion: string
  traceId: string
  domain: string
  basePath: string
}

/** 回源入口 HTML 并注入 window.YD（原 modifyHtml，去掉 locale 合并） */
export async function modifyHtml(input: ModifyHtmlInput): Promise<string> {
  const { siteUrl, app, selectedVersion, traceId, domain, basePath } = input
  const microApps = Array.isArray(app.microApps) ? (app.microApps as Record<string, unknown>[]) : []

  const htmlUrl = siteUrl.endsWith(".html") ? siteUrl : siteUrl.endsWith("/") ? `${siteUrl}index.html` : `${siteUrl}/index.html`
  let finalHtmlUrl = htmlUrl
  const cndDomain = getCndDomain()
  if (cndDomain) {
    try {
      finalHtmlUrl = htmlUrl.replace(new URL(htmlUrl).hostname, cndDomain)
    } catch {
      finalHtmlUrl = htmlUrl
    }
  }

  const cacheKey = `${finalHtmlUrl}::${getAppCacheFingerprint(app)}`
  const cached = htmlCache.get(cacheKey)
  if (cached) {
    logger.info({ span: "app:html:cache-hit", traceId, domain, reqPath: basePath, msg: `缓存命中: ${cacheKey}` })
    return cached
  }
  logger.info({ span: "app:html:cache-miss", traceId, domain, reqPath: basePath, msg: `缓存未命中: ${cacheKey}` })

  let html = ""
  const startTime = Date.now()
  try {
    const response = await fetch(finalHtmlUrl)
    html = await response.text()
    logger.info({ span: "app:html:success", traceId, domain, reqPath: basePath, msg: `获取html成功: ${htmlUrl}`, duration: Date.now() - startTime })
  } catch (error) {
    logger.error({ span: "app:html:error", traceId, domain, reqPath: basePath, msg: `获取html失败: ${htmlUrl}`, error: String(error) })
  }

  const env = (app.env ?? {}) as Record<string, unknown>
  const $ = cheerio.load(html)
  $("script").each((_, elem) => {
    const child = (elem as { children?: { type: string; data?: string }[] }).children?.find((n) => n.type === "text")
    if (child?.data && /window\.YD\s*=/.test(child.data)) {
      child.data = `window.YD = ${JSON.stringify({
        ...env,
        version: selectedVersion || String(app.version ?? ""),
        MICRO_APPS: microApps.map((item) => ({
          name: String(item.appId ?? ""),
          baseroute: String(item.baseroute ?? ""),
          url: `${String(item.url ?? "")}/${String(item.version ?? "")}/index.html`,
          iframe: Boolean(item.iframe),
          destroy: Boolean(item.destroy),
          config: (item.config ?? {}) as Record<string, unknown>,
        })),
      })};`
    }
  })

  // 修正 favicon 相对链接（原逻辑）
  const favicon = $('link[rel="shortcut icon"]').attr("href")
  if (favicon && !favicon.startsWith("http")) {
    $('link[rel="shortcut icon"]').attr("href", `${siteUrl}${favicon}`)
  }

  const result = $.html()
  if (html) htmlCache.set(cacheKey, result)
  return result
}
