import { check, listObjects, writeTuples } from "../authz/index.js"
import { env } from "../config/env.js"
import { db } from "../db/index.js"
import { errors } from "./errors.js"

export type KnowledgeBase = {
  id: string
  name: string
  slug: string | null
  description?: string
  settings?: { sourceType?: "documents" | "structured"; capabilities?: string[] }
  updatedAt: string
}

export async function knowledgeFetch(path: string, init?: RequestInit): Promise<Response> {
  if (!env.knowledgeServiceToken) throw errors.upstream(503, "未配置知识服务通信凭据")
  try {
    return await fetch(`${env.knowledgeUrl.replace(/\/+$/, "")}/api/doc-platform${path}`, {
      ...init,
      headers: { "content-type": "application/json", "x-knowledge-service-token": env.knowledgeServiceToken },
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    })
  } catch {
    throw errors.upstream(503, "知识服务不可用")
  }
}

export async function knowledgeJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await knowledgeFetch(path, init)
  const body = await response.json().catch(() => null) as { success?: boolean; data?: T } | null
  if (!response.ok || body?.success !== true) {
    if (response.status === 404) throw errors.notFound("knowledge_base")
    if (response.status === 400) throw errors.invalid("知识服务拒绝了请求，请检查参数")
    if (response.status === 409) throw errors.conflict("知识库地址已被占用")
    throw errors.upstream(502, "知识服务请求失败")
  }
  return body.data as T
}

export async function listKnowledgeBases(userId: string) {
  const ids = new Set(await listObjects(db, { subject: { type: "user", id: userId }, permission: "read", type: "knowledge_base" }))
  if (!ids.size) return []
  const bases = await knowledgeJson<KnowledgeBase[]>("/kb-admin/knowledge-bases")
  return bases.filter((base) => ids.has(base.id))
}

export async function assertKnowledgePermission(userId: string, id: string, permission: string) {
  if (!await check(db, { subject: { type: "user", id: userId }, permission, object: { type: "knowledge_base", id } })) {
    throw errors.notFound("knowledge_base")
  }
}

export async function createKnowledgeBase(userId: string, input: {
  name: string
  slug?: string
  languageCode?: string
  description?: string
  sourceType: "documents" | "structured"
  capabilities: string[]
  chunkStrategy?: string
  chunkSize?: number
  chunkOverlap?: number
}) {
  const base = await knowledgeJson<KnowledgeBase>("/kb-admin/knowledge-bases", {
    method: "POST",
    body: JSON.stringify({
      name: input.name,
      slug: input.slug ?? `kb-${crypto.randomUUID()}`,
      languageCode: input.languageCode ?? "zh-cn",
      description: input.description,
      // shortcut: 文档派生器当前仅实现 RAG；其它选择持久化为配置，待对应 worker 接入。
      modes: input.sourceType === "documents" && input.capabilities.includes("rag") ? ["rag"] : [],
      settings: { sourceType: input.sourceType, capabilities: input.capabilities },
      defaultChunkStrategy: input.chunkStrategy,
      defaultChunkConfig: { maxSize: input.chunkSize ?? 800, overlap: input.chunkOverlap ?? 120 },
    }),
  })
  // 未写成功授权的库保持不可见，禁止按 ownerId 或首次访问自动认领。
  await writeTuples(db, [{ resourceType: "knowledge_base", resourceId: base.id, relation: "owner", subjectType: "user", subjectId: userId, createdBy: userId }])
  return base
}

export function knowledgeEditorUrl(baseId: string, menuId?: string) {
  const url = new URL(`${env.docsUrl.replace(/\/+$/, "")}/${encodeURIComponent(baseId)}/zh-cn${menuId ? `/${encodeURIComponent(menuId)}` : ""}`)
  url.searchParams.set("from", "boss")
  return url.toString()
}
