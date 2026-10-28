/**
 * Hono 应用装配（导出给测试复用，不在这里 listen）。
 */
import { Hono } from "hono"
import { cors } from "hono/cors"
import { auth, enabledSocialProviders } from "./auth/index.js"
import { gitOAuthProviders } from "./lib/git/oauth.js"
import { env } from "./config/env.js"
import { AppError } from "./lib/errors.js"
import { requireAuth, type AppEnv } from "./middleware/auth.js"
import { gitProviderRoutes } from "./routes/git-providers.js"
import { modelRoutes } from "./routes/models.js"
import { gitWebhookRoutes } from "./routes/git-webhook.js"
import { gitOAuthRoutes } from "./routes/git-oauth.js"
import { orgRoutes } from "./routes/orgs.js"
import { appRoutes } from "./routes/apps.js"
import { publicFsRoutes } from "./routes/public-fs.js"
import { auditRoutes } from "./routes/audit.js"
import { requirementRoutes } from "./routes/requirements.js"
import { sessionRoutes } from "./routes/sessions.js"
import { connectorRoutes } from "./routes/connectors.js"
import { knowledgeRoutes } from "./routes/knowledge.js"
import { knowledgeLegacyRoutes } from "./routes/knowledge-legacy.js"
import { docPlatformRoutes } from "./routes/doc-platform.js"
import { saasFetch, saasJson, saasMcpFetch } from "./lib/saas.js"

export function createApp() {
  const app = new Hono<AppEnv>()

  app.use(
    "/api/*",
    cors({
      origin: env.trustedOrigins,
      credentials: true,
      // 兼容老编辑页上传正文时使用的空 contenttype 头（非标准拼写，会触发预检）。
      allowHeaders: ["content-type", "contenttype", "authorization", "x-org-id"],
      exposeHeaders: ["set-auth-token"],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    }),
  )

  app.onError((error, c) => {
    if (error instanceof AppError) {
      return c.json(error.toJSON(), error.status)
    }
    console.error("[hn-base-server] unhandled", error)
    return c.json({ code: "internal_error", message: "服务端错误" }, 500)
  })

  app.get("/health", (c) => c.json({ ok: true }))
  app.get("/api/models", requireAuth, async (c) => {
    const result = await saasJson<{ data: Array<{ id: string; providerID: string; name?: string; limit?: unknown }> }>("/api/model")
    // 只返回模型展示信息，不转发 provider settings（可能含密钥）。
    return c.json({ data: result.data.map(({ id, providerID, name, limit }) => ({ id, providerID, name, limit })) })
  })

  /** 公开配置：前端据此渲染可用的第三方登录入口（未配置则不返回） */
  app.get("/api/config", (c) =>
    c.json({
      providers: enabledSocialProviders,
      passwordEnabled: true,
      /** Git 连接可用的 OAuth2 方式（未配置时前端引导用 Access Token） */
      gitOAuth: { github: gitOAuthProviders().includes("github"), gitlab: gitOAuthProviders().includes("gitlab") },
    }),
  )

  // better-auth 端点（必须注册在 catch-all 之前）
  app.all("/api/auth/*", (c) => auth.handler(c.req.raw))

  // 当前用户上下文
  app.get("/api/me", requireAuth, (c) =>
    c.json({
      userId: c.get("userId"),
      orgId: c.get("orgId"),
      role: c.get("userRole"),
    }),
  )

  /**
   * Connector MCP 网关：沙箱携带会话级 Bearer token 访问基础服务，
   * 基础服务转发到 SaaS 的 /api/connector/mcp（不能把 SaaS 内网地址暴露给沙箱）。
   */
  app.post("/api/connector/mcp", async (c) => {
    const authorization = c.req.header("authorization")
    if (!authorization?.startsWith("Bearer ")) return c.json({ code: "unauthorized", message: "缺少 Connector Bearer token" }, 401)
    const response = await saasMcpFetch("/api/connector/mcp", {
      method: "POST",
      headers: {
        authorization,
        "content-type": c.req.header("content-type") ?? "application/json",
        accept: c.req.header("accept") ?? "application/json, text/event-stream",
      },
      body: await c.req.text(),
    })
    const headers = new Headers()
    const contentType = response.headers.get("content-type")
    if (contentType) headers.set("content-type", contentType)
    return new Response(await response.text(), { status: response.status, headers })
  })

  app.route("/api/requirements", requirementRoutes)
  app.on(["GET", "POST"], "/api/connector/mcp/:deploymentId", async (c) => {
    const id = c.req.param("deploymentId")
    if (!/^cmcp_[a-f0-9]{32}$/.test(id)) return c.json({ code: "not_found" }, 404)
    const authorization = c.req.header("authorization")
    if (!/^Bearer ocm_[A-Za-z0-9_-]{43}$/i.test(authorization ?? "")) return c.json({ code: "unauthorized" }, 401)
    const headers = new Headers({ authorization: authorization ?? "", accept: c.req.header("accept") ?? "application/json, text/event-stream" })
    for (const key of ["content-type", "mcp-protocol-version", "mcp-session-id", "origin", "last-event-id"]) {
      const value = c.req.header(key)
      if (value) headers.set(key, value)
    }
    const response = await saasMcpFetch(`/api/connector/mcp/${id}`, {
      method: c.req.method, headers, body: c.req.method === "POST" ? await c.req.text() : undefined, signal: c.req.raw.signal,
    })
    const outgoing = new Headers({ "cache-control": "no-store" })
    for (const key of ["content-type", "mcp-session-id", "mcp-protocol-version", "www-authenticate", "retry-after"]) {
      const value = response.headers.get(key)
      if (value) outgoing.set(key, value)
    }
    return new Response(response.body, { status: response.status, headers: outgoing })
  })
  app.route("/api/sessions", sessionRoutes)
  app.route("/api/connectors", connectorRoutes)
  app.route("/api/knowledge", knowledgeRoutes)
  app.route("/api/knowledge-legacy", knowledgeLegacyRoutes)
  /**
   * 老编辑页发布后的旧知识同步入口：发布流程已在知识服务内建派生任务，
   * 此处只做兼容应答，不读写数据。
   */
  app.post("/api/knowledge-base/sync-from-doc-platform", (c) =>
    c.json({ code: 200, success: true, message: "发布流程已提交派生任务", data: { taskId: "", knowledgeBaseId: "", operation: "upsertDocument", documentCount: 0, status: "accepted" } }),
  )
  app.route("/api/doc-platform", docPlatformRoutes)
  app.route("/api/git-providers/oauth", gitOAuthRoutes)
  app.route("/api/git-providers", gitProviderRoutes)
  app.route("/api/models", modelRoutes)
  app.route("/api/orgs", orgRoutes)
  app.route("/api/apps", appRoutes)
  // 公开文件访问（短期签名，无用户认证）
  app.route("/api/public/fs", publicFsRoutes)
  app.route("/api/audit", auditRoutes)
  // Git webhook：公开端点，靠签名校验（不走用户认证）
  app.route("/api/git/webhook", gitWebhookRoutes)

  return app
}

export type App = ReturnType<typeof createApp>
