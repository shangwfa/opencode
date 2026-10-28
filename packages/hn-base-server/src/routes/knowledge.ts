/** 工作台知识库入口；身份与授权全部复用基础服务。 */
import { Hono } from "hono"
import { z } from "zod"
import { errors } from "../lib/errors.js"
import { assertKnowledgePermission, createKnowledgeBase, knowledgeEditorUrl, knowledgeJson, listKnowledgeBases, type KnowledgeBase } from "../lib/knowledge.js"
import { requireAuth, type AppEnv } from "../middleware/auth.js"
import { env } from "../config/env.js"

const createBody = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  sourceType: z.enum(["documents", "structured"]),
  capabilities: z.array(z.enum(["rag", "graph", "wiki", "hybrid"])).max(4),
  chunkStrategy: z.enum(["none", "recursive", "character", "token", "markdown", "semantic-markdown", "llm-semantic", "html", "json", "latex", "sentence"]).optional(),
  chunkSize: z.number().int().min(1).max(100_000).optional(),
  chunkOverlap: z.number().int().min(0).max(100_000).optional(),
}).strict()
  .refine((input) => input.chunkOverlap === undefined || input.chunkOverlap < (input.chunkSize ?? 800), "重叠必须小于分块大小")
  .refine((input) => new Set(input.capabilities).size === input.capabilities.length, "能力不能重复")
  .refine((input) => input.capabilities.every((item) => (input.sourceType === "documents" ? ["rag", "graph", "wiki"] : ["hybrid", "graph"]).includes(item)), "能力与数据源不匹配")

export const knowledgeRoutes = new Hono<AppEnv>()
knowledgeRoutes.use("*", requireAuth)
knowledgeRoutes.use("*", async (c, next) => {
  const origin = c.req.header("origin")
  if (origin && !env.trustedOrigins.includes(origin)) throw errors.forbidden("不可信的请求来源")
  await next()
})
knowledgeRoutes.use("*", async (c, next) => { c.header("cache-control", "no-store"); await next() })

knowledgeRoutes.get("/bases", async (c) => {
  const bases = await listKnowledgeBases(c.get("userId"))
  return c.json({
    bases: await Promise.all(
      bases.map(async (base) => {
        const documents = await knowledgeJson<Array<{ status: string; publishedAt: string | null }>>(`/kb-admin/knowledge-bases/${encodeURIComponent(base.id)}/documents`)
        return {
          ...base,
          documentCount: documents.length,
          publishedCount: documents.filter((doc) => doc.publishedAt).length,
          failedCount: documents.filter((doc) => doc.status === "failed").length,
          pendingCount: documents.filter((doc) => doc.publishedAt && doc.status !== "indexed" && doc.status !== "failed").length,
          editorUrl: base.settings?.sourceType === "structured" ? null : knowledgeEditorUrl(base.id),
        }
      }),
    ),
  })
})

knowledgeRoutes.post("/bases", async (c) => {
  const parsed = createBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) throw errors.invalid("知识库参数不正确")
  const base = await createKnowledgeBase(c.get("userId"), parsed.data)
  return c.json({ base, editorUrl: parsed.data.sourceType === "documents" ? knowledgeEditorUrl(base.id) : null }, 201)
})

knowledgeRoutes.get("/overview", async (c) => {
  const bases = await listKnowledgeBases(c.get("userId"))
  const recent: Array<{ baseId: string; baseName: string; id: string; name: string; status: string; publishedAt: string | null; updatedAt: string }> = []
  let documentCount = 0
  let publishedCount = 0
  let pendingCount = 0
  let failedCount = 0
  for (const base of bases) {
    const documents = await knowledgeJson<Array<{ id: string; name: string; status: string; publishedAt: string | null; updatedAt: string }>>(`/kb-admin/knowledge-bases/${encodeURIComponent(base.id)}/documents`)
    documentCount += documents.length
    publishedCount += documents.filter((doc) => doc.publishedAt).length
    failedCount += documents.filter((doc) => doc.status === "failed").length
    pendingCount += documents.filter((doc) => doc.publishedAt && doc.status !== "indexed" && doc.status !== "failed").length
    for (const doc of documents) {
      recent.push({ baseId: base.id, baseName: base.name, ...doc })
    }
  }
  recent.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
  return c.json({
    overview: {
      baseCount: bases.length,
      documentCount,
      publishedCount,
      pendingCount,
      failedCount,
      recent: recent.slice(0, 8),
    },
  })
})

knowledgeRoutes.get("/bases/:baseId", async (c) => {
  const id = c.req.param("baseId")
  await assertKnowledgePermission(c.get("userId"), id, "read")
  const base = await knowledgeJson<KnowledgeBase>(`/kb-admin/knowledge-bases/${encodeURIComponent(id)}`)
  return c.json({ base, editorUrl: knowledgeEditorUrl(id) })
})

knowledgeRoutes.get("/bases/:baseId/documents", async (c) => {
  const id = c.req.param("baseId")
  await assertKnowledgePermission(c.get("userId"), id, "read")
  const documents = await knowledgeJson<Array<{ id: string; name: string; status: string; publishedAt: string | null; hasDraft: boolean }>>(`/kb-admin/knowledge-bases/${encodeURIComponent(id)}/documents`)
  return c.json({ documents: documents.map((doc) => ({ ...doc, editorUrl: knowledgeEditorUrl(id, doc.id) })) })
})
