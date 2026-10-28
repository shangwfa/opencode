/**
 * 文档服务:草稿/发布/读取
 * 正文唯一存储于 documents:content_json(结构化) + content(分块用派生文本)
 * 状态机: draft → published →(M2 派生)→ processing → indexed / failed
 */
import { and, eq } from "drizzle-orm"
import { db, documents, knowledgeBases, menus } from "../../db/index.js"
import { DocPlatformError, type PublishDocumentRequest, type SaveDraftRequest } from "../types.js"
import { extractPlainText } from "../utils.js"
import { syncWorkerService } from "./sync-worker.service.js"

export class DocumentService {
  /** 列表不返回草稿正文；写作状态和派生状态分开呈现。 */
  async listForAdmin(kbId: string) {
    const rows = await db.select({
      id: documents.id,
      name: menus.name,
      status: documents.status,
      publishedAt: documents.publishedAt,
      draftContentJson: documents.draftContentJson,
      updatedAt: documents.updatedAt,
    }).from(documents)
      .innerJoin(menus, and(eq(documents.menuId, menus.id), eq(menus.knowledgeBaseId, kbId)))
      .where(eq(documents.knowledgeBaseId, kbId))
    return rows.map(({ draftContentJson, ...row }) => ({ ...row, hasDraft: draftContentJson != null }))
  }

  /** 保存草稿:仅写 draft_content_json,不影响已发布内容 */
  async saveDraft(kbId: string, menuId: string, request: SaveDraftRequest) {
    const doc = await this.getDocRow(kbId, menuId)
    if (!doc) throw new DocPlatformError("NOT_FOUND", `文档不存在: ${menuId}`)
    const [updated] = await db
      .update(documents)
      .set({
        draftContentJson: request.contentJson as object,
        ...(request.contentType ? { type: request.contentType } : {}),
        ...(doc.status === "draft" ? {} : { status: doc.status }), // 保持既有发布态
        updatedAt: new Date(),
      })
      .where(and(eq(documents.id, menuId), eq(documents.knowledgeBaseId, kbId)))
      .returning()
    return this.serialize(updated)
  }

  /** 丢弃草稿 */
  async discardDraft(kbId: string, menuId: string) {
    const doc = await this.getDocRow(kbId, menuId)
    if (!doc) throw new DocPlatformError("NOT_FOUND", `文档不存在: ${menuId}`)
    const [updated] = await db
      .update(documents)
      .set({ draftContentJson: null, updatedAt: new Date() })
      .where(and(eq(documents.id, menuId), eq(documents.knowledgeBaseId, kbId)))
      .returning()
    return this.serialize(updated)
  }

  /** 发布:写 content_json,派生 content(分块输入),置 published_at/status */
  async publish(kbId: string, menuId: string, request: PublishDocumentRequest) {
    const doc = await this.getDocRow(kbId, menuId)
    if (!doc) throw new DocPlatformError("NOT_FOUND", `文档不存在: ${menuId}`)

    const plainText =
      request.plainTextContent?.trim() || extractPlainText(request.contentJson)
    if (!plainText) {
      throw new DocPlatformError("VALIDATION_ERROR", "发布内容不能为空")
    }

    // 正文与任务原子落库；worker 必须在事务提交后才启动。
    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
      .update(documents)
      .set({
        contentJson: request.contentJson as object,
        draftContentJson: null,
        content: plainText,
        ...(request.contentType ? { type: request.contentType } : {}),
        publishedAt: new Date(),
        status: "published",
        updatedAt: new Date(),
      })
      .where(and(eq(documents.id, menuId), eq(documents.knowledgeBaseId, kbId)))
      .returning()
      await syncWorkerService.enqueueDocumentSync(kbId, menuId, "upsert", true, tx, false)
      return row
    })
    syncWorkerService.wake()
    return this.serialize(updated)
  }

  /** 管理端读:草稿 + 已发布 */
  async getForAdmin(kbId: string, menuId: string) {
    const doc = await this.getDocRow(kbId, menuId)
    if (!doc) throw new DocPlatformError("NOT_FOUND", `文档不存在: ${menuId}`)
    return this.serialize(doc)
  }

  /** 公开读:校验 kb 公开 + 菜单 enable,返回内联正文(contentJson 序列化) */
  async getPublicContent(kbSlug: string, menuId: string) {
    const [row] = await db
      .select({
        isPublic: knowledgeBases.isPublic,
        contentJson: documents.contentJson,
        type: documents.type,
        publishedAt: documents.publishedAt,
        enable: menus.enable,
      })
      .from(documents)
      .innerJoin(menus, eq(documents.menuId, menus.id))
      .innerJoin(knowledgeBases, eq(documents.knowledgeBaseId, knowledgeBases.id))
      .where(and(eq(documents.id, menuId), eq(knowledgeBases.slug, kbSlug)))
      .limit(1)

    if (!row) throw new DocPlatformError("NOT_FOUND", `文档不存在: ${menuId}`)
    if (row.isPublic !== 1) throw new DocPlatformError("NOT_FOUND", `知识库未公开: ${kbSlug}`)
    if (row.enable !== 1) throw new DocPlatformError("NOT_FOUND", `文档不可见: ${menuId}`)
    if (!row.contentJson) throw new DocPlatformError("NOT_FOUND", `文档尚未发布: ${menuId}`)

    return {
      contentType: row.type,
      content: JSON.stringify(row.contentJson),
      publishedAt: row.publishedAt,
    }
  }

  /** 公开菜单树:kb 公开校验 + enable 过滤 */
  async assertKbPublic(kbSlug: string) {
    const [kb] = await db
      .select({ id: knowledgeBases.id, slug: knowledgeBases.slug })
      .from(knowledgeBases)
      .where(eq(knowledgeBases.slug, kbSlug))
      .limit(1)
    if (!kb) throw new DocPlatformError("NOT_FOUND", `知识库不存在: ${kbSlug}`)
    if ((await this.getKbPublicFlag(kb.id)) !== 1) {
      throw new DocPlatformError("NOT_FOUND", `知识库未公开: ${kbSlug}`)
    }
    return kb
  }

  private async getKbPublicFlag(kbId: string) {
    const [kb] = await db
      .select({ isPublic: knowledgeBases.isPublic })
      .from(knowledgeBases)
      .where(eq(knowledgeBases.id, kbId))
      .limit(1)
    return kb?.isPublic ?? 0
  }

  private async getDocRow(kbId: string, menuId: string) {
    const [doc] = await db
      .select()
      .from(documents)
      .where(and(eq(documents.id, menuId), eq(documents.knowledgeBaseId, kbId)))
      .limit(1)
    return doc ?? null
  }

  private serialize(doc: typeof documents.$inferSelect) {
    return {
      id: doc.id,
      menuId: doc.menuId,
      contentType: doc.type,
      draftContentJson: doc.draftContentJson,
      contentJson: doc.contentJson,
      content: doc.content,
      status: doc.status,
      publishedAt: doc.publishedAt,
      updatedAt: doc.updatedAt,
    }
  }
}
