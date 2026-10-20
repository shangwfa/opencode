/**
 * 会话访问网关。
 *
 * P0：列表 / 详情 / 消息 / SSE
 * P1：创建会话、发送消息、中止、文件读写
 *
 * 原则：
 *  - 归属判定在 base-server（ReBAC），SaaS 只认会话
 *  - 不转发 SaaS 的全局列表 `GET /session`
 *  - 无权限统一 404（不泄露存在性）
 */
import { Hono, type Context } from "hono"
import { z } from "zod"
import { check, listObjects, writeTuples } from "../authz/index.js"
import { db } from "../db/index.js"
import { requirement, requirementSession } from "../db/schema.js"
import { eq } from "drizzle-orm"
import { writeAudit, writeDeny } from "../lib/audit.js"
import { buildSignedPath } from "../lib/signed-url.js"
import { errors } from "../lib/errors.js"
import { saasFetch, isJson, toV2PromptBody, type SaasSession } from "../lib/saas.js"
import { requireAuth, type AppEnv } from "../middleware/auth.js"

const LIST_LIMIT = 50
const DEFAULT_DIRECTORY = "/workspace"

async function assertSession(userId: string, sessionId: string, permission = "read", c?: Context) {
  const ok = await check(db, {
    subject: { type: "user", id: userId },
    permission,
    object: { type: "session", id: sessionId },
  })
  if (!ok) {
    if (c) {
      await writeDeny(c, {
        actorId: userId,
        action: `session.${permission}`,
        resourceType: "session",
        resourceId: sessionId,
      })
    }
    throw errors.notFound("session")
  }
}

async function saasJsonOr(path: string, init?: RequestInit) {
  const res = await saasFetch(path, init)
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    // 透传上游语义：404 保持 404；503 表示沙箱未就绪；其余 5xx 归为上游错误
    if (res.status === 404) throw errors.notFound("session")
    if (res.status === 400) throw errors.invalid(text.slice(0, 200) || "上游参数错误")
    if (res.status === 503) throw errors.upstream(503, `执行服务暂不可用（沙箱未就绪）：${text.slice(0, 160)}`)
    if (res.status >= 500) throw errors.upstream(502, `执行服务错误 ${res.status}: ${text.slice(0, 160)}`)
    throw errors.internal(`执行服务返回 ${res.status}: ${text.slice(0, 200)}`)
  }
  return res
}

const createBody = z.object({
  /** 关联需求时，权限由需求的 run 权限决定，并写入 parent 关系 */
  requirementId: z.string().trim().min(1).optional(),
  title: z.string().trim().max(200).optional(),
  agent: z.string().trim().max(100).optional(),
  model: z.object({ providerID: z.string(), modelID: z.string() }).optional(),
  directory: z.string().trim().max(500).optional(),
  /** 派生会话：从已有会话 fork */
  parentSessionId: z.string().trim().min(1).optional(),
})

const messageBody = z.object({
  parts: z.array(z.record(z.string(), z.unknown())).min(1, "消息内容不能为空"),
  agent: z.string().trim().max(100).optional(),
  model: z.object({ providerID: z.string(), modelID: z.string() }).optional(),
  messageID: z.string().trim().max(100).optional(),
  noReply: z.boolean().optional(),
  system: z.string().max(50_000).optional(),
  tools: z.record(z.string(), z.unknown()).optional(),
})

export const sessionRoutes = new Hono<AppEnv>()

sessionRoutes.use("*", requireAuth)

/** 我的会话：先取可见 id，再向 SaaS 取元信息（不调 SaaS 全局列表） */
sessionRoutes.get("/", async (c) => {
  const userId = c.get("userId")
  const ids = await listObjects(db, {
    subject: { type: "user", id: userId },
    permission: "read",
    type: "session",
    limit: LIST_LIMIT,
  })
  const items: SaasSession[] = []
  for (const id of ids) {
    try {
      const res = await saasFetch(`/session/${encodeURIComponent(id)}`)
      if (!res.ok) continue
      items.push((await res.json()) as SaasSession)
    } catch {
      // 单个会话不可达不影响列表
    }
  }
  return c.json({ items })
})

/** 创建会话：可挂在需求下（继承需求权限 + 写 parent 关系） */
sessionRoutes.post("/", async (c) => {
  const parsed = createBody.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw errors.invalid(issue?.message ?? "参数错误", issue?.path?.join("."))
  }
  const input = parsed.data
  const userId = c.get("userId")

  let directory = input.directory ?? DEFAULT_DIRECTORY
  let parentTuple: { resourceType: "requirement" | "session"; resourceId: string } | undefined

  if (input.requirementId) {
    const ok = await check(db, {
      subject: { type: "user", id: userId },
      permission: "run",
      object: { type: "requirement", id: input.requirementId },
    })
    if (!ok) throw errors.notFound("requirement")

    const rows = await db.select().from(requirement).where(eq(requirement.id, input.requirementId)).limit(1)
    const req = rows[0]
    if (!req) throw errors.notFound("requirement")
    parentTuple = { resourceType: "requirement", resourceId: req.id }
  }

  if (input.parentSessionId) {
    await assertSession(userId, input.parentSessionId, "read", c)
    parentTuple = { resourceType: "session", resourceId: input.parentSessionId }
  }

  // 调 SaaS 创建会话（directory 走 body.location，query 不生效）
  const created = (await (
    await saasJsonOr("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(input.title ? { title: input.title } : {}),
        ...(input.agent ? { agent: input.agent } : {}),
        // Model.Ref 是 { id, providerID }
        ...(input.model ? { model: { id: input.model.modelID, providerID: input.model.providerID } } : {}),
        ...(input.parentSessionId ? { parentID: input.parentSessionId } : {}),
        location: { directory },
      }),
    })
  ).json()) as { data?: SaasSession } | SaasSession

  const createdSession = (created as { data?: SaasSession }).data ?? (created as SaasSession)
  if (!createdSession?.id) throw errors.internal("创建会话失败：响应缺少 id")
  const createdId = createdSession.id

  await db.transaction(async (tx) => {
    await writeTuples(tx as unknown as typeof db, [
      { resourceType: "session", resourceId: createdId, relation: "owner", subjectType: "user", subjectId: userId, createdBy: userId },
      ...(parentTuple
        ? [
            {
              resourceType: "session" as const,
              resourceId: createdId,
              relation: "parent",
              subjectType: parentTuple.resourceType,
              subjectId: parentTuple.resourceId,
              createdBy: userId,
            },
          ]
        : []),
    ])
    if (input.requirementId) {
      await tx.insert(requirementSession).values({
        id: `rs_${crypto.randomUUID().replace(/-/g, "")}`,
        requirementId: input.requirementId,
        sessionId: createdId,
        role: input.parentSessionId ? "derived" : "primary",
        timeCreated: Date.now(),
      })
    }
  })

  await writeAudit(
    {
      actorId: userId,
      action: "session.create",
      resourceType: "session",
      resourceId: createdId,
      metadata: { requirementId: input.requirementId ?? null, derived: Boolean(input.parentSessionId) },
    },
    c,
  )
  return c.json({ session: createdSession }, 201)
})

/** 发送消息（阻塞式；流式请用 /message/stream 或 SSE）。PromptInput：text。 */
sessionRoutes.post("/:id/message", async (c) => {
  const id = c.req.param("id")
  await assertSession(c.get("userId"), id, "run", c)
  const parsed = messageBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw errors.invalid(issue?.message ?? "参数错误", issue?.path?.join("."))
  }
  const res = await saasJsonOr(`/api/session/${encodeURIComponent(id)}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(toV2PromptBody(parsed.data)),
  })
  return c.json(await res.json().catch(() => ({ ok: true })))
})

/** 中止 */
sessionRoutes.post("/:id/abort", async (c) => {
  const id = c.req.param("id")
  await assertSession(c.get("userId"), id, "abort", c)
  const res = await saasJsonOr(`/session/${encodeURIComponent(id)}/abort`, { method: "POST" })
  await writeAudit(
    { actorId: c.get("userId"), action: "session.abort", resourceType: "session", resourceId: id },
    c,
  )
  return c.json(await res.json().catch(() => ({ ok: true })))
})

/** 文件：列表 / 内容（路径通过 path 查询参数） */
sessionRoutes.get("/:id/fs", async (c) => {
  const id = c.req.param("id")
  await assertSession(c.get("userId"), id, "read", c)
  const path = c.req.query("path") ?? ""
  const query = new URLSearchParams({ path, sessionID: id })
  const res = await saasJsonOr(`/file?${query.toString()}`)
  return c.json(await res.json())
})

/** 生成短期签名 URL（5 分钟），供 <img>/下载 使用 */
sessionRoutes.post("/:id/fs/sign", async (c) => {
  const id = c.req.param("id")
  await assertSession(c.get("userId"), id, "read", c)
  const body = (await c.req.json().catch(() => null)) as { path?: string } | null
  const path = body?.path?.trim()
  if (!path) throw errors.invalid("缺少 path", "path")
  return c.json(buildSignedPath(id, path))
})

sessionRoutes.get("/:id/fs/content", async (c) => {
  const id = c.req.param("id")
  await assertSession(c.get("userId"), id, "read", c)
  const path = c.req.query("path") ?? ""
  if (!path) throw errors.invalid("缺少 path", "path")
  const query = new URLSearchParams({ path, sessionID: id })
  const res = await saasJsonOr(`/file/content?${query.toString()}`)
  const contentType = res.headers.get("content-type") ?? "application/octet-stream"
  // 二进制（图片等）透传，Text 走 JSON 包装
  if (contentType.startsWith("image/") || contentType.startsWith("application/octet-stream")) {
    return new Response(res.body, { status: 200, headers: { "content-type": contentType } })
  }
  return c.json(await res.json().catch(() => ({ content: "" })))
})

/** 子会话 */
sessionRoutes.get("/:id/children", async (c) => {
  const id = c.req.param("id")
  await assertSession(c.get("userId"), id, "read", c)
  const res = await saasJsonOr(`/session/${encodeURIComponent(id)}/children`)
  return c.json(await res.json())
})

/** 详情 */
sessionRoutes.get("/:id", async (c) => {
  const id = c.req.param("id")
  await assertSession(c.get("userId"), id, "read", c)
  const res = await saasFetch(`/session/${encodeURIComponent(id)}`)
  if (!res.ok) throw errors.notFound("session")
  return c.json(await res.json())
})

sessionRoutes.get("/:id/messages", async (c) => {
  const id = c.req.param("id")
  await assertSession(c.get("userId"), id, "read", c)
  const res = await saasFetch(`/api/session/${encodeURIComponent(id)}/message?order=asc&limit=100`)
  if (!res.ok) throw errors.notFound("session")
  return c.json(await res.json())
})

/** SSE 透传：保持流式，客户端断开时取消上游 */
sessionRoutes.get("/:id/event", async (c) => {
  const id = c.req.param("id")
  await assertSession(c.get("userId"), id, "read", c)
  const abort = new AbortController()
  c.req.raw.signal.addEventListener("abort", () => abort.abort())
  const res = await saasFetch(`/api/session/${encodeURIComponent(id)}/event`, { signal: abort.signal })
  if (!res.ok || !res.body) throw errors.notFound("session")
  return new Response(res.body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  })
})
