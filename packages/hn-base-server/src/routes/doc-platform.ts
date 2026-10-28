/** hn-docs 管理 API 网关：校验基础服务会话及资源权限，绝不接受客户端服务凭据。 */
import { Hono, type Context } from "hono"
import { bodyLimit } from "hono/body-limit"
import { z } from "zod"
import { deleteResourceGraph } from "../authz/index.js"
import { db } from "../db/index.js"
import { errors } from "../lib/errors.js"
import { assertKnowledgePermission, createKnowledgeBase, knowledgeFetch, listKnowledgeBases } from "../lib/knowledge.js"
import { requireAuth, type AppEnv } from "../middleware/auth.js"
import { env } from "../config/env.js"

const createBody = z.object({
  name: z.string().trim().min(1).max(200),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
  languageCode: z.enum(["zh-cn", "en-us"]).optional(),
  description: z.string().max(2000).optional(),
}).strict()

export const docPlatformRoutes = new Hono<AppEnv>()
docPlatformRoutes.use("*", requireAuth)
docPlatformRoutes.use("*", bodyLimit({ maxSize: 3 * 1024 * 1024 }))
docPlatformRoutes.use("*", async (c, next) => {
  // Cookie 登录同样校验来源；CORS 本身并不拦截写请求。
  const origin = c.req.header("origin")
  if (origin) {
    if (!env.trustedOrigins.includes(origin)) throw errors.forbidden("不可信的请求来源")
  }
  c.header("cache-control", "no-store")
  await next()
})

docPlatformRoutes.get("/kb-admin/knowledge-bases", async (c) =>
  c.json({ code: 200, success: true, data: await listKnowledgeBases(c.get("userId")) }))

docPlatformRoutes.post("/kb-admin/knowledge-bases", async (c) => {
  const parsed = createBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) throw errors.invalid("知识库参数不正确")
  const data = await createKnowledgeBase(c.get("userId"), { ...parsed.data, sourceType: "documents", capabilities: ["rag"] })
  return c.json({ code: 200, success: true, data })
})

docPlatformRoutes.all("/kb-admin/knowledge-bases/:baseId/*", proxyResource)
docPlatformRoutes.all("/kb-admin/knowledge-bases/:baseId", proxyResource)

async function proxyResource(c: Context<AppEnv>) {
  const id = c.req.param("baseId")!
  const prefix = `/api/doc-platform/kb-admin/knowledge-bases/${encodeURIComponent(id)}`
  const tail = c.req.path.slice(prefix.length)
  // 限定可转发的方法与子路径，避免宽泛代理绕过资源权限。
  const method = c.req.method
  const allowed = (
    (tail === "" && ["GET", "DELETE"].includes(method)) ||
    (tail === "/public" && method === "POST") ||
    (tail === "/menus/tree" && method === "GET") ||
    (tail === "/documents" && method === "GET") ||
    (tail === "/menus" && method === "POST") ||
    (/^\/menus\/[A-Za-z0-9_-]+$/.test(tail) && method === "DELETE") ||
    (/^\/menus\/[A-Za-z0-9_-]+\/(enable|disable)$/.test(tail) && method === "POST") ||
    (/^\/documents\/[A-Za-z0-9_-]+$/.test(tail) && method === "GET") ||
    (/^\/documents\/[A-Za-z0-9_-]+\/draft$/.test(tail) && ["PUT", "DELETE"].includes(method)) ||
    (/^\/documents\/[A-Za-z0-9_-]+\/publish$/.test(tail) && method === "POST")
  )
  if (!allowed) throw errors.notFound()
  const permission = method === "GET" ? "read" : tail === "" ? "delete" : tail === "/public" ? "manage" : "write"
  await assertKnowledgePermission(c.get("userId"), id, permission)
  let body: string | undefined
  if (["POST", "PUT"].includes(method)) {
    const value = await c.req.json().catch(() => null)
    const schema = tail === "/menus"
      ? z.object({ name: z.string().trim().min(1).max(200), type: z.enum(["folder", "doc"]), parentId: z.string().nullable().optional(), previousId: z.string().nullable().optional() }).strict()
      : tail === "/public" ? z.object({ isPublic: z.boolean() }).strict()
      : tail.endsWith("/enable") || tail.endsWith("/disable") ? z.object({}).strict()
      : z.object({ contentJson: z.object({ type: z.literal("doc"), content: z.array(z.unknown()).optional() }).passthrough(), contentType: z.literal("tiptap").optional(), plainTextContent: z.string().optional() }).strict()
    const parsed = schema.safeParse(value ?? {})
    if (!parsed.success) throw errors.invalid("文档参数不正确")
    body = JSON.stringify(parsed.data)
  }
  const query = method === "GET" && tail === "/menus/tree" ? "?includeDisabled=1" : ""
  const response = await knowledgeFetch(`/kb-admin/knowledge-bases/${encodeURIComponent(id)}${tail}${query}`, { method, body })
  if (response.ok && method === "DELETE" && tail === "") await deleteResourceGraph(db, "knowledge_base", id)
  return new Response(response.body, { status: response.status, headers: { "content-type": "application/json", "cache-control": "no-store" } })
}
