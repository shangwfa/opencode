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
import { gitWebhookRoutes } from "./routes/git-webhook.js"
import { gitOAuthRoutes } from "./routes/git-oauth.js"
import { orgRoutes } from "./routes/orgs.js"
import { appRoutes } from "./routes/apps.js"
import { publicFsRoutes } from "./routes/public-fs.js"
import { auditRoutes } from "./routes/audit.js"
import { requirementRoutes } from "./routes/requirements.js"
import { sessionRoutes } from "./routes/sessions.js"
import { saasJson } from "./lib/saas.js"

export function createApp() {
  const app = new Hono<AppEnv>()

  app.use(
    "/api/*",
    cors({
      origin: env.webOrigin,
      credentials: true,
      allowHeaders: ["content-type", "authorization", "x-org-id"],
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

  app.route("/api/requirements", requirementRoutes)
  app.route("/api/sessions", sessionRoutes)
  app.route("/api/git-providers/oauth", gitOAuthRoutes)
  app.route("/api/git-providers", gitProviderRoutes)
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
