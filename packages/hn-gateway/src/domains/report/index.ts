/**
 * /report-api 前端上报域（原 report.controller 一比一迁移）。
 * - POST /：x-encrypted-data 头存在时解密请求体（RSA+AES），结构化日志 + PG 事件 + span=http 错误的飞书告警
 * - GET /code/:filePath/:ref：GitLab 项目原始文件（app.gitLab 字段解析项目路径）
 * - GET /app/:appId/:version：应用配置视图（剔除 env/microApps，publishList 按版本过滤）
 * - GET /log/:traceId、POST /search、POST /customSearch：ELK 透传
 */
import { Hono } from "hono"
import { UAParser } from "ua-parser-js"
import { appService } from "../apps/service.js"
import { db, reportEvents } from "../../db/index.js"
import { logger } from "../../logger.js"
import { decryptReport } from "../../hosting/utils/crypto.js"
import { getDefaultDomain } from "../../config/env.js"
import { sendFeishuAlert } from "../../integrations/feishu-alert.js"
import { getProjectId, getRawFile } from "../../integrations/gitlab-client.js"
import { searchCustomLogs, searchLogs, searchLogsByTraceId } from "../../integrations/elk-client.js"
import { responseFormatter } from "../../middleware/response-formatter.js"

export const reportApp = new Hono()

// 原全局 ResponseFormatterInterceptor 语义（注册须在路由定义之前）
reportApp.use("*", responseFormatter)

// 原 POST /report-api/
reportApp.post("/", async (c) => {
  const traceId = c.req.header("x-trace-id") ?? ""
  const domain = (c.req.header("domain") || c.req.header("host") || "").toLowerCase()
  const baseRoute = new URL(c.req.url).pathname.split("/")[2] ?? ""
  const app = await appService.getAppByDomain(domain, baseRoute) ?? (await appService.getAppByDomain(domain, "")) ?? undefined

  let body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const encrypted = c.req.header("x-encrypted-data")
  if (encrypted) {
    try {
      const decrypted = decryptReport(body as { data: string; key: string })
      if (decrypted && typeof decrypted === "object") {
        body = decrypted as Record<string, unknown>
        logger.debug({ span: "report:decrypt:success", traceId, msg: "Report data decrypted successfully" })
      }
    } catch (error) {
      logger.error({ span: "report:decrypt:error", traceId, msg: "Failed to decrypt report data", error: String(error) })
    }
  }

  const ua = new UAParser(c.req.header("user-agent") || "").getResult()
  const level = String(body.level ?? "error")
  const info = {
    level,
    msg: String(body.msg ?? ""),
    logger: String(body.logger ?? ""),
    env: process.env["GATEWAY_ENV"] ?? "online",
    service: "hn-gateway",
    traceId,
    hostname: "",
    date: new Date().toISOString(),
    exception: String(body.exception ?? ""),
    domain,
    path: new URL(c.req.url).pathname,
    browserName: ua.browser.name ?? "",
    browserVersion: ua.browser.major ?? "",
    osName: ua.os.name ?? "",
    osVersion: ua.os.version ?? "",
    ...body,
  }

  // 结构化日志（原 ELK 采集路径）
  console.log(JSON.stringify(info))

  // PG 事件落库（本方案新增的可查存储）
  await db.insert(reportEvents).values({
    appId: app ? String(app.appId) : null,
    traceId: traceId || "unknown",
    level,
    message: String(body.msg ?? ""),
    payload: body as Record<string, unknown>,
  })

  // 原"异常通知"：span=http 的 error 用 res.code/res.msg/href 构造 post 富文本（原 report.controller 载荷）
  const webhook = (app?.env as { ERROR_WEB_HOOK?: string } | undefined)?.ERROR_WEB_HOOK
  if (typeof webhook === "string" && webhook && level === "error" && body.span === "http") {
    try {
      const reqInfo = JSON.parse(String(body.req || "{}")) as { method?: string; url?: string }
      const resInfo = JSON.parse(String(body.res || "{}")) as { code?: unknown; msg?: unknown }
      await sendFeishuAlert({
        webhook,
        appName: String(app?.name ?? ""),
        method: String(reqInfo.method ?? ""),
        targetUrl: String(reqInfo.url ?? ""),
        page: String(body.href ?? ""),
        traceId,
        errorCode: String(resInfo.code ?? ""),
        errorMsg: String(resInfo.msg ?? ""),
      })
    } catch (error) {
      logger.error({ span: "report:alert:error", traceId, msg: "上报告警构造失败", error: String(error) })
    }
  }

  // 原返回值：'success' 文本
  return c.text("success")
})

// 原 GET /report-api/code/:filePath/:ref
reportApp.get("/code/*", async (c) => {
  const url = new URL(c.req.url)
  // 路径形如 /report-api/code/<filePath...>，ref 取 query
  const filePath = url.pathname.replace(/^\/report-api\/code\//, "")
  const ref = url.searchParams.get("ref") ?? ""
  const domain = (c.req.header("domain") || c.req.header("host") || "").toLowerCase()
  const app = await appService.getAppByDomain(domain || getDefaultDomain(), "")
  if (!app) return c.text("应用不存在")

  const gitLabUrl = String(app.gitLab ?? "")
  if (!gitLabUrl) return c.text("应用未配置 gitLab")
  const projectPath = gitLabUrl
    .replace("https://gitlab.winrobot360.com/", "")
    .replace("https://gitlab.shadow-rpa.net/", "")
    .replace(/\/$/, "")
  const projectId = await getProjectId(projectPath)
  return c.text(await getRawFile(projectId, filePath, ref))
})

// 原 GET /report-api/app/:appId/:version
reportApp.get("/app/:appId/:version", async (c) => {
  const appId = c.req.param("appId")
  const version = c.req.param("version")
  const platform = await appService.getPlatform()
  const app = Object.values(platform).find((item) => item.appId === appId)
  if (!app) return c.text("应用不存在")

  const { env: _env, microApps: _microApps, ...rest } = app
  const publishList = Array.isArray(app.publishList) ? (app.publishList as Record<string, unknown>[]) : []
  const target = version ? (publishList.find((item) => item.version === version) ?? publishList[0]) : publishList[0]
  return c.json({ ...rest, publishList: target ? [target] : [] })
})

// 原 GET /report-api/log/:traceId/
reportApp.get("/log/:traceId", async (c) => c.json(await searchLogsByTraceId(c.req.param("traceId"))))

// 原 POST /report-api/search
reportApp.post("/search", async (c) => c.json(await searchLogs(await c.req.json().catch(() => ({})))))

// 原 POST /report-api/customSearch
reportApp.post("/customSearch", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { serverName?: string }
  return c.json(await searchCustomLogs(body))
})
