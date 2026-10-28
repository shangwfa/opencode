/**
 * 知识库服务:KB CRUD + 多模式初始化
 * rag 模式后端即 knowledge_bases 自身;其余模式当前不支持创建(仅透出 rag)
 */
import { and, asc, eq, isNotNull } from "drizzle-orm"
import { db, knowledgeBases, kbModes, schemaName } from "../../db/index.js"
import { vectorService } from "../../rag/knowledge-base/services/index.js"
import { DocPlatformError, type CreateKbRequest, type KbMode, type UpdateKbRequest } from "../types.js"
import { validateKbSlug } from "../utils.js"

const SUPPORTED_MODES: KbMode[] = ["rag"]

function newId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`
}

function toBool(v: number | boolean | null | undefined): boolean {
  return v === 1 || v === true
}

export class KbService {
  /** 创建知识库:modes 默认 ['rag'];同步写 kb_modes(rag 后端=自身,backend_id 空) */
  async createKb(request: CreateKbRequest) {
    const slug = request.slug?.trim()
    if (!slug) throw new DocPlatformError("VALIDATION_ERROR", "slug 不能为空")
    validateKbSlug(slug)

    const modes = request.modes ?? (["rag"] as KbMode[])
    const unsupported = modes.filter((m) => !SUPPORTED_MODES.includes(m))
    if (unsupported.length) {
      throw new DocPlatformError("UNSUPPORTED_MODE", `暂不支持检索模式: ${unsupported.join(", ")}(当前仅 rag)`)
    }

    const conflict = await db
      .select({ id: knowledgeBases.id })
      .from(knowledgeBases)
      .where(and(eq(knowledgeBases.slug, slug), isNotNull(knowledgeBases.slug)))
      .limit(1)
    if (conflict.length) {
      throw new DocPlatformError("CONFLICT", `slug 已被占用: ${slug}`)
    }

    const id = newId("kb")
    const [kb] = await db
      .insert(knowledgeBases)
      .values({
        id,
        name: request.name,
        description: request.description ?? null,
        slug,
        languageCode: request.languageCode ?? "zh-cn",
        isPublic: 0,
        settings: request.settings ?? {},
        ...(request.defaultChunkStrategy ? { defaultChunkStrategy: request.defaultChunkStrategy } : {}),
        ...(request.defaultChunkConfig ? { defaultChunkConfig: request.defaultChunkConfig } : {}),
      })
      .returning()

    for (const mode of modes) {
      await db.insert(kbModes).values({ knowledgeBaseId: id, mode, enabled: 1, backendId: null })
    }

    // rag 模式后端即本表,同步初始化向量索引(幂等;失败不阻塞建库,worker 兜底)
    if (modes.includes("rag")) {
      try {
        await vectorService.createIndex(id, 1536)
      } catch (error: any) {
        console.warn(`[doc-platform] 知识库 ${id} 向量索引初始化失败(将派生时重试):`, error.message)
      }
    }

    return this.serializeKb(kb, modes)
  }

  async listKbs() {
    const rows = await db.select().from(knowledgeBases).orderBy(asc(knowledgeBases.createdAt))
    return Promise.all(rows.map((r) => this.serializeKb(r)))
  }

  async getKb(kbId: string) {
    const [kb] = await db.select().from(knowledgeBases).where(eq(knowledgeBases.id, kbId)).limit(1)
    if (!kb) throw new DocPlatformError("NOT_FOUND", `知识库不存在: ${kbId}`)
    return this.serializeKb(kb)
  }

  /** 按 slug 查(公开读入口) */
  async getKbBySlug(slug: string) {
    const [kb] = await db.select().from(knowledgeBases).where(eq(knowledgeBases.slug, slug)).limit(1)
    if (!kb) throw new DocPlatformError("NOT_FOUND", `知识库不存在: ${slug}`)
    return this.serializeKb(kb)
  }

  async updateKb(kbId: string, patch: UpdateKbRequest) {
    const kb = await this.getKbRow(kbId)
    const values: Partial<typeof knowledgeBases.$inferInsert> = { updatedAt: new Date() }

    if (patch.slug !== undefined && patch.slug !== kb.slug) {
      const slug = patch.slug.trim()
      validateKbSlug(slug)
      const conflict = await db
        .select({ id: knowledgeBases.id })
        .from(knowledgeBases)
        .where(and(eq(knowledgeBases.slug, slug), isNotNull(knowledgeBases.slug)))
        .limit(1)
      if (conflict.length && conflict[0].id !== kbId) {
        throw new DocPlatformError("CONFLICT", `slug 已被占用: ${slug}`)
      }
      values.slug = slug
    }
    if (patch.name !== undefined) values.name = patch.name
    if (patch.languageCode !== undefined) values.languageCode = patch.languageCode
    if (patch.description !== undefined) values.description = patch.description
    if (patch.isPublic !== undefined) values.isPublic = patch.isPublic ? 1 : 0
    if (patch.settings !== undefined) values.settings = patch.settings

    const [updated] = await db
      .update(knowledgeBases)
      .set(values)
      .where(eq(knowledgeBases.id, kbId))
      .returning()
    return this.serializeKb(updated)
  }

  async deleteKb(kbId: string) {
    await this.getKbRow(kbId)
    // documents/menus/kb_modes/kb_aliases 均对 knowledge_bases 级联删除
    await db.delete(knowledgeBases).where(eq(knowledgeBases.id, kbId))
  }

  async getKbRow(kbId: string) {
    const [kb] = await db.select().from(knowledgeBases).where(eq(knowledgeBases.id, kbId)).limit(1)
    if (!kb) throw new DocPlatformError("NOT_FOUND", `知识库不存在: ${kbId}`)
    return kb
  }

  async listModes(kbId: string) {
    return db.select().from(kbModes).where(eq(kbModes.knowledgeBaseId, kbId))
  }

  private async serializeKb(row: typeof knowledgeBases.$inferSelect, modes?: KbMode[]) {
    const modeRows = modes?.map((mode) => ({ mode, enabled: true })) ?? (await this.listModes(row.id))
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      languageCode: row.languageCode,
      description: row.description,
      isPublic: toBool(row.isPublic),
      ownerId: row.ownerId,
      settings: row.settings ?? {},
      modes: modeRows.map((m) => ({ mode: m.mode, enabled: toBool(m.enabled) })),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }
}

export const kbSchemaName = schemaName
