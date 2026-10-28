/**
 * v1 兼容层上传缓存:
 * v1 交互中,前端保存正文/草稿前先 getUploadUrl 取地址、PUT 内容到 OSS,
 * 再把 content key 传给 saveDoc/draft。compat 层用本表承接:key → 内容(JSON)。
 * 资源类(doc_asset)不走本表,直接上传 Vercel Blob(putResource)。
 */
import { eq } from "drizzle-orm"
import { compatUploads, db } from "../../db/index.js"

export interface CompatUpload {
  key: string
  knowledgeBaseId: string | null
  kind: string
  contentType: string | null
  payload: unknown
  blobUrl: string | null
}

export async function putCompatUpload(params: {
  key: string
  knowledgeBaseId?: string
  kind?: string
  contentType?: string
  payload: unknown
}): Promise<void> {
  const values = {
    key: params.key,
    knowledgeBaseId: params.knowledgeBaseId ?? null,
    kind: params.kind ?? "doc",
    contentType: params.contentType ?? null,
    payload: params.payload as object,
    createdAt: new Date(),
  }
  // upsert:getUploadUrl 先预插占位行,PUT 内容时覆盖
  await db
    .insert(compatUploads)
    .values(values)
    .onConflictDoUpdate({
      target: compatUploads.key,
      set: {
        payload: values.payload,
        contentType: values.contentType,
        kind: values.kind,
        updatedAt: new Date(),
      },
    })
}

export async function getCompatUpload(key: string): Promise<CompatUpload | null> {
  const [row] = await db
    .select()
    .from(compatUploads)
    .where(eq(compatUploads.key, key))
    .limit(1)
  return (row as CompatUpload) ?? null
}

export function compatUploadKey(): string {
  return `compat_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`
}
