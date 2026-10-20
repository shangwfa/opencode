/**
 * 连接器目录与个人连接管理。
 *
 * 目录来自 SaaS Connector 服务；连接写入用户级隐藏会话的资源域。
 * 基础服务只代理响应，不保存第三方凭据。
 */
import { Hono } from "hono"
import { z } from "zod"
import { env } from "../config/env.js"
import { writeAudit } from "../lib/audit.js"
import { connectorSession } from "../lib/connectors.js"
import { callbackUrl, gitOAuthEnabled } from "../lib/git/oauth.js"
import { errors } from "../lib/errors.js"
import { saasFetch } from "../lib/saas.js"
import { requireAuth, type AppEnv } from "../middleware/auth.js"

const authType = z.enum(["no_auth", "api_key", "custom_credential", "oauth2"])

const createBody = z.object({
  service: z.string().trim().min(1).max(200),
  authType: z.enum(["api_key", "custom_credential"]),
  values: z
    .record(z.string(), z.string())
    .refine((value) => Object.keys(value).length > 0 && Object.entries(value).every(([key, item]) => key.trim() && item.trim()), "请填写有效连接凭据"),
  alias: z.string().trim().max(100).optional(),
})

const oauthBody = z.object({
  service: z.string().trim().min(1).max(200),
  alias: z.string().trim().max(100).optional(),
  authorizationOptionIds: z.array(z.string()).max(50).optional(),
})

async function requiredSession(userId: string): Promise<string> {
  const sessionId = await connectorSession(userId, { create: true })
  if (!sessionId) throw errors.internal("连接器空间创建失败")
  return sessionId
}

async function upstream(path: string, init?: RequestInit): Promise<unknown> {
  const response = await saasFetch(path, init)
  const text = await response.text().catch(() => "")
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  if (!response.ok) {
    const message =
      (body as { message?: string; _tag?: string } | null)?.message ??
      (body as { _tag?: string } | null)?._tag ??
      text.slice(0, 200) ??
      `连接器服务返回 ${response.status}`
    if (response.status === 400) throw errors.invalid(message)
    if (response.status === 404) throw errors.notFound("connector_connection")
    if (response.status === 409) throw errors.conflict(message, "connector_conflict")
    if (response.status === 503) throw errors.upstream(503, message)
    throw errors.upstream(502, `连接器服务错误 ${response.status}：${message}`)
  }
  return body
}

export const connectorRoutes = new Hono<AppEnv>()

connectorRoutes.use("*", requireAuth)

connectorRoutes.get("/providers", async (c) => {
  const parsed = z
    .object({
      service: z.string().trim().max(200).optional(),
      authType: authType.optional(),
      category: z.string().trim().max(100).optional(),
    })
    .safeParse(c.req.query())
  if (!parsed.success) throw errors.invalid("连接器筛选参数不正确")
  const query = new URLSearchParams()
  if (parsed.data.service) query.set("service", parsed.data.service)
  if (parsed.data.authType) query.set("authType", parsed.data.authType)
  if (parsed.data.category) query.set("category", parsed.data.category)
  const suffix = query.size ? `?${query.toString()}` : ""
  c.header("cache-control", "private, max-age=60")
  return c.json(await upstream(`/api/connector/providers${suffix}`))
})

connectorRoutes.get("/providers/:service", async (c) => {
  c.header("cache-control", "private, max-age=60")
  return c.json(await upstream(`/api/connector/providers/${encodeURIComponent(c.req.param("service"))}`))
})

connectorRoutes.get("/categories", async (c) => {
  c.header("cache-control", "private, max-age=60")
  return c.json(await upstream("/api/connector/categories"))
})

connectorRoutes.get("/connections", async (c) => {
  const sessionId = await connectorSession(c.get("userId"))
  if (!sessionId) return c.json({ connections: [] })
  return c.json(await upstream(`/api/session/${encodeURIComponent(sessionId)}/connector/connections`))
})

const deploymentPath = (sessionId: string, id?: string) =>
  `/api/session/${encodeURIComponent(sessionId)}/connector/mcp-deployments${id ? `/${encodeURIComponent(id)}` : ""}`
const deploymentCreate = z.object({
  name: z.string().trim().min(1).max(100), service: z.string().trim().min(1).max(200),
  connectionId: z.string().min(1).optional(), actionIds: z.array(z.string().min(1)).min(1),
}).strict()
const deploymentUpdate = z.object({
  revision: z.number().int().positive(), name: z.string().trim().min(1).max(100).optional(),
  status: z.enum(["active", "disabled"]).optional(), actionIds: z.array(z.string().min(1)).min(1).optional(),
  confirmContracts: z.boolean().optional(),
}).strict()
const deploymentRevision = z.object({ revision: z.number().int().positive() }).strict()

connectorRoutes.get("/mcp-deployments", async (c) => {
  c.header("cache-control", "no-store")
  const sessionId = await connectorSession(c.get("userId"))
  if (!sessionId) return c.json({ deployments: [], publicBaseUrl: env.publicBaseUrl.replace(/\/+$/, "") })
  const body = z.object({ deployments: z.array(z.unknown()) }).parse(await upstream(deploymentPath(sessionId)))
  return c.json({ deployments: body.deployments, publicBaseUrl: env.publicBaseUrl.replace(/\/+$/, "") })
})
connectorRoutes.post("/mcp-deployments", async (c) => {
  const parsed = deploymentCreate.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) throw errors.invalid("MCP 名称、账号或工具选择无效")
  const sessionId = await requiredSession(c.get("userId"))
  c.header("cache-control", "no-store")
  const body = await upstream(deploymentPath(sessionId), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(parsed.data) })
  await writeAudit({ actorId: c.get("userId"), action: "connector.mcp.create", resourceType: "connector_scope", resourceId: c.get("userId"), metadata: { service: parsed.data.service } }, c)
  return c.json(body, 201)
})
connectorRoutes.patch("/mcp-deployments/:id", async (c) => {
  const parsed = deploymentUpdate.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) throw errors.invalid("MCP 更新参数无效")
  const sessionId = await requiredSession(c.get("userId"))
  c.header("cache-control", "no-store")
  const body = await upstream(deploymentPath(sessionId, c.req.param("id")), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(parsed.data) })
  await writeAudit({ actorId: c.get("userId"), action: "connector.mcp.update", resourceType: "connector_mcp", resourceId: c.req.param("id") }, c)
  return c.json(body)
})
connectorRoutes.post("/mcp-deployments/:id/rotate-token", async (c) => {
  const parsed = deploymentRevision.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) throw errors.invalid("请刷新 MCP 配置后重试")
  const sessionId = await requiredSession(c.get("userId"))
  c.header("cache-control", "no-store")
  const body = await upstream(`${deploymentPath(sessionId, c.req.param("id"))}/rotate-token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(parsed.data) })
  await writeAudit({ actorId: c.get("userId"), action: "connector.mcp.rotate", resourceType: "connector_mcp", resourceId: c.req.param("id") }, c)
  return c.json(body)
})
connectorRoutes.delete("/mcp-deployments/:id", async (c) => {
  const sessionId = await connectorSession(c.get("userId"))
  if (!sessionId) return c.body(null, 204)
  await upstream(deploymentPath(sessionId, c.req.param("id")), { method: "DELETE" })
  await writeAudit({ actorId: c.get("userId"), action: "connector.mcp.delete", resourceType: "connector_mcp", resourceId: c.req.param("id") }, c)
  return c.body(null, 204)
})

connectorRoutes.post("/mcp", async (c) => {
  const sessionId = await requiredSession(c.get("userId"))
  const body = (await upstream(`/api/session/${encodeURIComponent(sessionId)}/connector/mcp`, { method: "POST" })) as {
    name?: string
    config?: Record<string, unknown>
  } | null
  // SaaS 的 MCP 是内网地址；沙箱只访问基础服务，由基础服务带 Bearer token 转发。
  if (body?.config && typeof body.config === "object") {
    body.config.url = `${env.publicBaseUrl.replace(/\/+$/, "")}/api/connector/mcp`
  }
  await writeAudit(
    {
      actorId: c.get("userId"),
      action: "connector.mcp.attach",
      resourceType: "connector_scope",
      resourceId: c.get("userId"),
      metadata: { name: (body as { name?: string } | null)?.name ?? "connector" },
    },
    c,
  )
  return c.json(body, 201)
})

connectorRoutes.post("/connections", async (c) => {
  const parsed = createBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw errors.invalid(issue?.message ?? "连接参数不正确", issue?.path?.join("."))
  }
  if (parsed.data.authType === "api_key" && !parsed.data.values.apiKey?.trim()) throw errors.invalid("请填写 API Key", "values.apiKey")
  const sessionId = await requiredSession(c.get("userId"))
  const body = await upstream(`/api/session/${encodeURIComponent(sessionId)}/connector/connections`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(parsed.data),
  })
  await writeAudit(
    {
      actorId: c.get("userId"),
      action: "connector.connection.create",
      resourceType: "connector_connection",
      resourceId: (body as { id?: string } | null)?.id ?? parsed.data.service,
      metadata: { service: parsed.data.service, authType: parsed.data.authType },
    },
    c,
  )
  return c.json(body, 201)
})

connectorRoutes.delete("/connections/:connectionId", async (c) => {
  const connectionId = c.req.param("connectionId")
  const sessionId = await connectorSession(c.get("userId"))
  if (!sessionId) return c.body(null, 204)
  await upstream(`/api/session/${encodeURIComponent(sessionId)}/connector/connections/${encodeURIComponent(connectionId)}`, {
    method: "DELETE",
  })
  await writeAudit(
    {
      actorId: c.get("userId"),
      action: "connector.connection.remove",
      resourceType: "connector_connection",
      resourceId: connectionId,
    },
    c,
  )
  return c.body(null, 204)
})

connectorRoutes.post("/connections/:connectionId/reconnect", async (c) => {
  const connectionId = c.req.param("connectionId")
  const sessionId = await requiredSession(c.get("userId"))
  return c.json(
    await upstream(
      `/api/session/${encodeURIComponent(sessionId)}/connector/connections/${encodeURIComponent(connectionId)}/reconnect`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    ),
  )
})

connectorRoutes.post("/oauth/start", async (c) => {
  const parsed = oauthBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) throw errors.invalid("OAuth 参数不正确")
  // GitHub 复用现有 Git Provider OAuth App：同一 clientId/secret，回调由 base-server 转发。
  if (parsed.data.service === "github" && gitOAuthEnabled("github")) {
    await upstream("/api/connector/oauth/clients/github", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientId: env.gitGithubClientId,
        clientSecret: env.gitGithubClientSecret,
        redirectUri: callbackUrl("github"),
      }),
    })
  }
  const sessionId = await requiredSession(c.get("userId"))
  return c.json(
    await upstream(`/api/session/${encodeURIComponent(sessionId)}/connector/connections/oauth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(parsed.data),
    }),
  )
})

connectorRoutes.post("/oauth/:requestId/complete", async (c) => {
  const parsed = z
    .object({ alias: z.string().trim().max(100).optional() })
    .safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) throw errors.invalid("OAuth 参数不正确")
  const sessionId = await requiredSession(c.get("userId"))
  return c.json(
    await upstream(
      `/api/session/${encodeURIComponent(sessionId)}/connector/connections/oauth/${encodeURIComponent(c.req.param("requestId"))}/complete`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(parsed.data) },
    ),
  )
})

connectorRoutes.get("/runs", async (c) => {
  const parsed = z
    .object({ cursor: z.string().max(500).optional(), limit: z.coerce.number().int().min(1).max(100).optional() })
    .safeParse(c.req.query())
  if (!parsed.success) throw errors.invalid("分页参数不正确")
  // The engine endpoint is admin-global. Do not expose other users' runs through a logged-in proxy.
  throw errors.upstream(503, "连接器运行记录尚未支持用户隔离，暂不开放")
})
