/**
 * Open API 文档服务(BookDocumentService v2)
 *
 * 原 hn-docs lib/book-open/service.ts 的后端化实现:
 * - upstream(yddoc/Boss/OSS 二跳)全部替换为 doc-platform dp 表读写
 * - 正文唯一存储于 documents(content_json),contentKey 契约保留(dp://{id} 形态)
 * - 知识库派生改为同进程 enqueueDocumentSync(knowledgeTaskIds 契约字段返回 dst 任务 id)
 * - 部分(partia_success)语义、block 物化、资源订正行为保持一致
 * - 鉴权后置(决策 #4):permission 返回全放行上下文
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, documents, knowledgeBases } from "../../db/index.js";
import { syncWorkerService } from "../services/sync-worker.service.js";
import { DocPlatformError } from "../types.js";
import { assertPermission, buildPermissionContext } from "./compat.js";
import {
  findTopLevelBlock,
  materializeTopLevelBlockIds,
  replaceTopLevelBlock,
} from "./blocks.js";
import { inspectDocumentContent } from "./content.js";
import { BookOpenError } from "./errors.js";
import { validatedContentType } from "./resource-content-type.js";
import { downloadPublicResource } from "./resource-download.js";
import {
  normalizeDocumentResources,
  type ImportableResourceKind,
  type ResourceImportRequest,
} from "./resource-normalizer.js";
import type {
  CreateDocumentInput,
  CreateResourceUploadInput,
  DeleteDocumentInput,
  GetBlockInput,
  GetDocumentInput,
  SetDocumentEnabledInput,
  UpdateBlockInput,
  UpdateDocumentInput,
} from "./schemas.js";
import type { DocumentRecord, MenuNode, OpenContext } from "./types.js";
import {
  createPresignedPut,
  objectPath,
  ossPublicDomain,
  putResource,
  uploadMode,
} from "./oss.service.js";

interface OperationState {
  requestId: string;
  completedStages: string[];
  menuId?: string;
  docUniqueId?: string;
  knowledgeTaskIds?: string[];
}

function requestId(input?: string): string {
  return input || randomUUID();
}

function temporaryUploadContextId(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, "").slice(0, 32) || randomUUID().replace(/-/g, "").slice(0, 32);
}

const MAX_IMAGE_RESOURCE_BYTES = 20 * 1024 * 1024;
const MAX_OTHER_RESOURCE_BYTES = 200 * 1024 * 1024;

const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "application/pdf": "pdf",
  "application/json": "json",
  "text/plain": "txt",
  "application/zip": "zip",
};

function maxResourceBytes(kind: ImportableResourceKind): number {
  return kind === "image" ? MAX_IMAGE_RESOURCE_BYTES : MAX_OTHER_RESOURCE_BYTES;
}

function generatedResourceFileName(bytes: Buffer, contentType: string): string {
  const extension = CONTENT_TYPE_EXTENSIONS[contentType] ?? "bin";
  return `normalized-${randomUUID().slice(0, 12)}.${extension}`;
}

function uploadResourcePath(upload: { key: string; readUrl?: string }): string {
  if (upload.readUrl) {
    // 完整可读 URL(如 Vercel Blob)直接保留;OSS 相对路径语义则截取 pathname
    try {
      const url = new URL(upload.readUrl);
      if (url.protocol === "http:" || url.protocol === "https:") return url.toString().replace(/\/$/, "");
    } catch {
      /* 非合法 URL,按 key 处理 */
    }
    return upload.readUrl;
  }
  return upload.key;
}

function findDocumentNode(
  nodes: MenuNode[],
  docUniqueId: string,
): MenuNode | undefined {
  for (const node of nodes) {
    if (node.type === "doc" && (node.docUniqueId === docUniqueId || node.id === docUniqueId)) return node;
    const child = findDocumentNode(node.menuTrees ?? [], docUniqueId);
    if (child) return child;
  }
  return undefined;
}

function menuPath(
  nodes: MenuNode[],
  menuId: string,
  parents: string[] = [],
): { docPath?: string; parentPath?: string } {
  for (const node of nodes) {
    const current = [...parents, node.name];
    if (node.id === menuId) {
      return { docPath: current.join("/"), parentPath: parents.join("/") };
    }
    const result = menuPath(node.menuTrees ?? [], menuId, current);
    if (result.docPath) return result;
  }
  return {};
}

function partialError(
  error: unknown,
  state: OperationState,
  failedStage: string,
  details: Record<string, unknown> = {},
): BookOpenError {
  const message = error instanceof Error ? error.message : "操作失败";
  return new BookOpenError("PARTIAL_SUCCESS", message, {
    status: "partial_success",
    requestId: state.requestId,
    menuId: state.menuId,
    docUniqueId: state.docUniqueId,
    completedStages: state.completedStages,
    failedStage,
    knowledgeTaskIds: state.knowledgeTaskIds,
    retryAction: state.docUniqueId ? "update_document" : "create_document",
    ...details,
  });
}

function blockIdSeed(params: { kb: string; docUniqueId: string }): string {
  return `${params.kb}:${params.docUniqueId}`;
}

export class OpenDocumentService {
  /**
   * 解析 kb 引用(slug 或 id)→ OpenContext(全放行,决策 #4)
   */
  private async context(kbRef: string, callerId?: string): Promise<OpenContext> {
    const [kb] = await db
      .select()
      .from(knowledgeBases)
      .where(eq(knowledgeBases.id, kbRef))
      .limit(1);
    const row =
      kb ??
      (
        await db
          .select()
          .from(knowledgeBases)
          .where(eq(knowledgeBases.slug, kbRef))
          .limit(1)
      )[0];
    if (!row) throw new BookOpenError("NOT_FOUND", `知识库不存在: ${kbRef}`);
    return buildPermissionContext(
      { id: callerId },
      {
        kbId: row.id,
        kbSlug: row.slug || row.id,
        languageCode: row.languageCode || "zh-cn",
        settings: (row.settings as Record<string, unknown>) ?? {},
      },
    );
  }

  /** 菜单树(管理视图,含禁用项) */
  private async menuTree(kbId: string): Promise<MenuNode[]> {
    const rows = await db
      .select({
        id: menus.id,
        parentId: menus.parentId,
        previousId: menus.previousId,
        name: menus.name,
        type: menus.type,
        iconUrl: menus.iconUrl,
        slug: menus.slug,
        enable: menus.enable,
        docUniqueId: menus.docUniqueId,
      })
      .from(menus)
      .where(eq(menus.knowledgeBaseId, kbId));
    return buildOpenTree(rows);
  }

  /**
   * 解析文档:菜单节点 + documents 行(record.content 即正文,已入库)
   */
  private async resolveDocument(
    context: OpenContext,
    docUniqueId: string,
  ): Promise<{ tree: MenuNode[]; node: MenuNode; record: DocumentRecord }> {
    const tree = await this.menuTree(context.kbId);
    const node = findDocumentNode(tree, docUniqueId);
    if (!node) {
      throw new BookOpenError("NOT_FOUND", "文档不存在", { docUniqueId });
    }
    const [doc] = await db
      .select()
      .from(documents)
      .where(and(eq(documents.id, node.id), eq(documents.knowledgeBaseId, context.kbId)))
      .limit(1);
    const record: DocumentRecord = {
      menuId: node.id,
      docUniqueId,
      name: node.name,
      enable: node.enable !== false,
      contentKey: doc ? `dp://${doc.id}` : undefined,
      contentType: doc?.type,
      hasDraft: !!doc?.draftContentJson,
      content: doc?.contentJson ?? undefined,
    };
    return { tree, node, record };
  }

  private async loadMaterializedContent(params: {
    record: DocumentRecord;
    kb: string;
    docUniqueId: string;
    version: "published" | "draft";
  }) {
    const raw = params.record.content;
    if (!raw) {
      throw new BookOpenError("NOT_FOUND", "文档没有正文");
    }
    return materializeTopLevelBlockIds(inspectDocumentContent(raw).content, {
      seed: blockIdSeed({ kb: params.kb, docUniqueId: params.docUniqueId }),
    });
  }

  /** 资源订正:data:/外链 → OSS 相对路径(行为与 v1 一致) */
  private async normalizeContentResources(params: {
    context: OpenContext;
    content: unknown;
    requestId: string;
    docUniqueId?: string;
  }) {
    const uploadContextId =
      params.docUniqueId ?? temporaryUploadContextId(params.requestId);

    const importResource = async (request: ResourceImportRequest) => {
      const maxBytes = maxResourceBytes(request.resourceKind);
      let bytes: Buffer;
      let declaredContentType: string;
      let sourceUrl: string | undefined;

      if (request.sourceType === "data") {
        bytes = request.bytes;
        declaredContentType = request.contentType;
      } else {
        const downloaded = await downloadPublicResource(request.url, maxBytes);
        bytes = downloaded.bytes;
        declaredContentType = downloaded.contentType;
        sourceUrl = downloaded.sourceUrl;
      }

      if (bytes.length > maxBytes) {
        throw new BookOpenError(
          "VALIDATION_ERROR",
          request.resourceKind === "image"
            ? "图片大小不能超过 20MB"
            : "资源大小不能超过 200MB",
        );
      }
      const contentType = validatedContentType(
        request.resourceKind,
        declaredContentType,
        bytes,
        sourceUrl,
      );
      const fileName = generatedResourceFileName(bytes, contentType);

      // Vercel Blob:服务端上传模型,直接 put(无预签名直传)
      if (uploadMode() === "vercel-blob") {
        const uploaded = await putResource({
          bytes,
          contentType,
          fileName,
          contextId: uploadContextId,
          envCode: params.context.envCode,
        });
        return uploadResourcePath({ key: uploaded.key, readUrl: uploaded.readUrl });
      }

      const upload = await createPresignedPut({
        fileName,
        fileSize: bytes.length,
        contentType,
        contextId: uploadContextId,
        envCode: params.context.envCode,
      });
      // 服务端直传(v1 行为:服务端完成 OSS PUT)
      const put = await fetch(upload.uploadUrl, {
        method: "PUT",
        body: new Uint8Array(bytes),
        headers: { "Content-Type": contentType },
      });
      if (!put.ok) {
        throw new BookOpenError("UPSTREAM_ERROR", `资源上传失败: OSS PUT ${put.status}`);
      }
      return uploadResourcePath(upload);
    };

    return normalizeDocumentResources(params.content, {
      // Vercel Blob:托管域后缀(已上传资源的 URL hostname 命中即保留,不重搬运)
      getOssDomain: async () =>
        uploadMode() === "vercel-blob" ? ".public.blob.vercel-storage.com" : ossPublicDomain(),
      importResource,
    });
  }

  /**
   * 保存正文:v2 直接落 documents(不再 OSS 中转)
   * draft → draft_content_json;publish → content_json + content 派生 + 派生任务
   */
  private async saveContent(params: {
    context: OpenContext;
    menuId: string;
    docUniqueId: string;
    content: unknown;
    publishMode: "draft" | "publish";
  }): Promise<{ contentKey: string; plainTextContent: string }> {
    const inspection = inspectDocumentContent(params.content);
    if (params.publishMode === "draft") {
      await db
        .update(documents)
        .set({
          draftContentJson: inspection.content as object,
          type: "tiptap",
          updatedAt: new Date(),
        })
        .where(and(eq(documents.id, params.docUniqueId), eq(documents.knowledgeBaseId, params.context.kbId)));
      return {
        contentKey: `dp://${params.docUniqueId}?version=draft`,
        plainTextContent: inspection.plainTextContent,
      };
    }

    await db
      .update(documents)
      .set({
        contentJson: inspection.content as object,
        content: inspection.plainTextContent,
        type: "tiptap",
        publishedAt: new Date(),
        status: "published",
        updatedAt: new Date(),
      })
      .where(and(eq(documents.id, params.docUniqueId), eq(documents.knowledgeBaseId, params.context.kbId)));

    return {
      contentKey: `dp://${params.docUniqueId}`,
      plainTextContent: inspection.plainTextContent,
    };
  }

  /** 派生入队(契约字段 knowledgeTaskIds 的来源) */
  private async enqueueUpsert(params: {
    context: OpenContext;
    docUniqueId: string;
  }): Promise<string> {
    await syncWorkerService.enqueueDocumentSync(params.context.kbId, params.docUniqueId, "upsert", true);
    return `dst_${params.docUniqueId}`;
  }

  private async enqueueDelete(params: {
    context: OpenContext;
    docUniqueId: string;
  }): Promise<string> {
    await syncWorkerService.enqueueDocumentSync(params.context.kbId, params.docUniqueId, "delete", true);
    return `dst_${params.docUniqueId}`;
  }

  private async setEnable(kbId: string, menuId: string, enable: boolean): Promise<void> {
    await db
      .update(menus)
      .set({ enable: enable ? 1 : 0, updatedAt: new Date() })
      .where(and(eq(menus.id, menuId), eq(menus.knowledgeBaseId, kbId)));
  }

  private async createDocMenu(
    context: OpenContext,
    input: { name: string; parentId?: string | number; previousId?: string | number },
  ): Promise<{ id: string; docUniqueId: string }> {
    const id = `${Date.now()}${Math.random().toString(36).substring(2, 8)}`;
    await db.insert(menus).values({
      id,
      knowledgeBaseId: context.kbId,
      parentId: input.parentId ? String(input.parentId) : null,
      previousId: input.previousId ? String(input.previousId) : null,
      name: input.name,
      type: "doc",
      enable: 0, // 创建即禁用,发布成功后启用(保留 v1 阶段语义)
      docUniqueId: id,
    });
    await db.insert(documents).values({
      id,
      knowledgeBaseId: context.kbId,
      content: "",
      type: "tiptap",
      status: "draft",
      menuId: id,
    });
    return { id, docUniqueId: id };
  }

  // ────────────────────────── 对外操作(契约方法) ──────────────────────────

  async listDocuments(input: { kb: string }) {
    const context = await this.context(input.kb);
    assertPermission(context, "read");
    const tree = await this.menuTree(context.kbId);
    return {
      kb: context.kbSlug,
      languageCode: context.languageCode,
      tree,
    };
  }

  async getDocument(input: GetDocumentInput) {
    const context = await this.context(input.kb);
    assertPermission(context, "read");
    const { node, record } = await this.resolveDocument(context, input.docUniqueId);

    let version: "published" | "draft" = "published";
    let content = record.content;
    if (input.version === "draft" || (input.version === "effective" && record.hasDraft)) {
      if (!record.hasDraft) {
        if (input.version === "draft") throw new BookOpenError("NOT_FOUND", "文档没有草稿");
      } else {
        version = "draft";
        content = (record.content as any) ? undefined : undefined; // draft 单独取
        const [doc] = await db
          .select({ draft: documents.draftContentJson })
          .from(documents)
          .where(and(eq(documents.id, node.id), eq(documents.knowledgeBaseId, context.kbId)))
          .limit(1);
        content = doc?.draft ?? undefined;
      }
    }

    const materialized = content
      ? materializeTopLevelBlockIds(inspectDocumentContent(content).content, {
          seed: blockIdSeed({ kb: input.kb, docUniqueId: input.docUniqueId }),
        })
      : content;
    return {
      kb: context.kbSlug,
      languageCode: context.languageCode,
      menuId: node.id,
      docUniqueId: input.docUniqueId,
      name: record.name,
      enabled: node.enable !== false,
      version,
      hasDraft: record.hasDraft === true,
      contentKey: record.contentKey,
      content: materialized,
    };
  }

  async getBlock(input: GetBlockInput) {
    const context = await this.context(input.kb);
    assertPermission(context, "read");
    const { node, record } = await this.resolveDocument(context, input.docUniqueId);
    const hasDraft = record.hasDraft === true;
    let version: "published" | "draft" =
      input.version === "draft" || (input.version === "effective" && hasDraft) ? (hasDraft ? "draft" : "published") : "published";
    if (input.version === "draft" && !hasDraft) {
      throw new BookOpenError("NOT_FOUND", "文档没有草稿");
    }
    let content: unknown = record.content;
    if (version === "draft") {
      const [doc] = await db
        .select({ draft: documents.draftContentJson })
        .from(documents)
        .where(and(eq(documents.id, node.id), eq(documents.knowledgeBaseId, context.kbId)))
        .limit(1);
      content = doc?.draft ?? undefined;
    }
    const materialized = await this.loadMaterializedContent({
      record: { ...record, content },
      kb: input.kb,
      docUniqueId: input.docUniqueId,
      version,
    });
    const found = findTopLevelBlock(materialized, input.blockId);
    return {
      kb: context.kbSlug,
      languageCode: context.languageCode,
      menuId: node.id,
      docUniqueId: input.docUniqueId,
      blockId: input.blockId,
      version,
      contentKey: record.contentKey,
      index: found.index,
      block: found.block,
    };
  }

  async createDocument(input: CreateDocumentInput) {
    const operation: OperationState = {
      requestId: requestId(input.requestId),
      completedStages: [],
      knowledgeTaskIds: [],
    };
    const context = await this.context(input.kb);
    assertPermission(context, "create");

    const normalized = await this.normalizeContentResources({
      context,
      content: input.content,
      requestId: operation.requestId,
    });
    const normalizedInspection = inspectDocumentContent(normalized.content);
    const inspection = inspectDocumentContent(
      materializeTopLevelBlockIds(normalizedInspection.content),
    );

    let failedStage = "create_menu";
    try {
      const created = await this.createDocMenu(context, {
        name: input.name,
        parentId: input.parentId,
        previousId: input.previousId,
      });
      operation.menuId = created.id;
      operation.docUniqueId = created.docUniqueId;
      operation.completedStages.push("create_menu");

      failedStage = "disable_document";
      await this.setEnable(context.kbId, created.id, false);
      operation.completedStages.push("disable_document");

      failedStage = "save_content";
      const saved = await this.saveContent({
        context,
        menuId: created.id,
        docUniqueId: created.docUniqueId,
        content: inspection.content,
        publishMode: input.publishMode,
      });
      operation.completedStages.push("save_content");

      if (input.publishMode === "draft") {
        return {
          status: "success",
          requestId: operation.requestId,
          menuId: created.id,
          docUniqueId: created.docUniqueId,
          publishStatus: "draft",
          enabled: false,
          contentKey: saved.contentKey,
        };
      }

      failedStage = "knowledge_sync_task";
      const taskId = await this.enqueueUpsert({ context, docUniqueId: created.docUniqueId });
      operation.knowledgeTaskIds?.push(taskId);
      operation.completedStages.push("knowledge_sync_task");

      failedStage = "enable_document";
      await this.setEnable(context.kbId, created.id, true);
      operation.completedStages.push("enable_document");
      return {
        status: "success",
        requestId: operation.requestId,
        menuId: created.id,
        docUniqueId: created.docUniqueId,
        publishStatus: "published",
        enabled: true,
        contentKey: saved.contentKey,
        knowledgeSync: { status: "queued", taskId },
      };
    } catch (error) {
      if (!operation.menuId) throw error;
      throw partialError(error, operation, failedStage);
    }
  }

  async updateDocument(input: UpdateDocumentInput) {
    const operation: OperationState = {
      requestId: requestId(input.requestId),
      completedStages: [],
      docUniqueId: input.docUniqueId,
      knowledgeTaskIds: [],
    };
    const context = await this.context(input.kb);
    assertPermission(context, "update");
    const { node, record } = await this.resolveDocument(context, input.docUniqueId);
    operation.menuId = node.id;

    if (input.expectedContentKey && input.expectedContentKey !== record.contentKey) {
      throw new BookOpenError("CONFLICT", "文档已被其他操作更新", {
        expectedContentKey: input.expectedContentKey,
        currentContentKey: record.contentKey,
      });
    }

    let inspection: ReturnType<typeof inspectDocumentContent> | undefined;
    if (input.content) {
      const normalized = await this.normalizeContentResources({
        context,
        content: input.content,
        requestId: operation.requestId,
        docUniqueId: input.docUniqueId,
      });
      const normalizedInspection = inspectDocumentContent(normalized.content);
      inspection = inspectDocumentContent(
        materializeTopLevelBlockIds(normalizedInspection.content, {
          seed: blockIdSeed({ kb: input.kb, docUniqueId: input.docUniqueId }),
        }),
      );
    }

    let failedStage = "update_metadata";
    try {
      if (input.name !== undefined || input.parentId !== undefined || input.previousId !== undefined) {
        await db
          .update(menus)
          .set({
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.parentId !== undefined ? { parentId: String(input.parentId) } : {}),
            ...(input.previousId !== undefined ? { previousId: String(input.previousId) } : {}),
            updatedAt: new Date(),
          })
          .where(and(eq(menus.id, node.id), eq(menus.knowledgeBaseId, context.kbId)));
        operation.completedStages.push("update_metadata");
      }

      let contentKey = record.contentKey;
      if (inspection && input.publishMode) {
        failedStage = "save_content";
        const saved = await this.saveContent({
          context,
          menuId: node.id,
          docUniqueId: input.docUniqueId,
          content: inspection.content,
          publishMode: input.publishMode,
        });
        contentKey = saved.contentKey;
        operation.completedStages.push("save_content");
      }

      let knowledgeSync: { status: "queued"; taskId: string } | undefined;
      if (inspection && input.publishMode === "publish") {
        failedStage = "knowledge_sync_task";
        const taskId = await this.enqueueUpsert({ context, docUniqueId: input.docUniqueId });
        operation.knowledgeTaskIds?.push(taskId);
        operation.completedStages.push("knowledge_sync_task");
        knowledgeSync = { status: "queued", taskId };
      }

      return {
        status: "success",
        requestId: operation.requestId,
        menuId: node.id,
        docUniqueId: input.docUniqueId,
        publishStatus: input.publishMode,
        enabled: node.enable !== false,
        contentKey,
        knowledgeSync,
      };
    } catch (error) {
      throw partialError(error, operation, failedStage);
    }
  }

  async updateBlock(input: UpdateBlockInput) {
    const operation: OperationState = {
      requestId: requestId(input.requestId),
      completedStages: [],
      docUniqueId: input.docUniqueId,
      knowledgeTaskIds: [],
    };
    const context = await this.context(input.kb);
    assertPermission(context, "update");
    const { node, record } = await this.resolveDocument(context, input.docUniqueId);
    operation.menuId = node.id;

    const hasDraft = record.hasDraft === true;
    const version: "published" | "draft" =
      input.publishMode === "draft" && hasDraft ? "draft" : "published";
    let sourceContent: unknown = record.content;
    if (version === "draft") {
      const [doc] = await db
        .select({ draft: documents.draftContentJson })
        .from(documents)
        .where(and(eq(documents.id, node.id), eq(documents.knowledgeBaseId, context.kbId)))
        .limit(1);
      sourceContent = doc?.draft ?? undefined;
    }
    const currentContent = await this.loadMaterializedContent({
      record: { ...record, content: sourceContent },
      kb: input.kb,
      docUniqueId: input.docUniqueId,
      version,
    });
    const replaced = replaceTopLevelBlock(currentContent, input.blockId, input.block);
    const normalized = await this.normalizeContentResources({
      context,
      content: replaced.content,
      requestId: operation.requestId,
      docUniqueId: input.docUniqueId,
    });
    const inspection = inspectDocumentContent(normalized.content);
    const savedBlock = findTopLevelBlock(inspection.content, input.blockId).block;

    let failedStage = "save_content";
    try {
      const saved = await this.saveContent({
        context,
        menuId: node.id,
        docUniqueId: input.docUniqueId,
        content: inspection.content,
        publishMode: input.publishMode,
      });
      operation.completedStages.push("save_content");

      let knowledgeSync: { status: "queued"; taskId: string } | undefined;
      if (input.publishMode === "publish") {
        failedStage = "knowledge_sync_task";
        const taskId = await this.enqueueUpsert({ context, docUniqueId: input.docUniqueId });
        operation.knowledgeTaskIds?.push(taskId);
        operation.completedStages.push("knowledge_sync_task");
        knowledgeSync = { status: "queued", taskId };
      }

      return {
        status: "success",
        requestId: operation.requestId,
        menuId: node.id,
        docUniqueId: input.docUniqueId,
        blockId: input.blockId,
        publishStatus: input.publishMode,
        contentKey: saved.contentKey,
        block: savedBlock,
        knowledgeSync,
      };
    } catch (error) {
      throw partialError(error, operation, failedStage, {
        blockId: input.blockId,
        retryAction: "update_block",
      });
    }
  }

  async setDocumentEnabled(input: SetDocumentEnabledInput) {
    const operation: OperationState = {
      requestId: requestId(input.requestId),
      completedStages: [],
      docUniqueId: input.docUniqueId,
      knowledgeTaskIds: [],
    };
    const context = await this.context(input.kb);
    assertPermission(context, "enable");
    const { node, record } = await this.resolveDocument(context, input.docUniqueId);
    operation.menuId = node.id;

    let failedStage = input.enabled ? "knowledge_sync_task" : "disable_document";
    try {
      let taskId: string;
      if (input.enabled) {
        if (!record.content) throw new BookOpenError("CONFLICT", "文档没有可发布的正文");
        taskId = await this.enqueueUpsert({ context, docUniqueId: input.docUniqueId });
        operation.completedStages.push("knowledge_sync_task");
        failedStage = "enable_document";
        await this.setEnable(context.kbId, node.id, true);
        operation.completedStages.push("enable_document");
      } else {
        await this.setEnable(context.kbId, node.id, false);
        operation.completedStages.push("disable_document");
        failedStage = "knowledge_sync_task";
        taskId = await this.enqueueDelete({ context, docUniqueId: input.docUniqueId });
        operation.completedStages.push("knowledge_sync_task");
      }
      operation.knowledgeTaskIds?.push(taskId);
      return {
        status: "success",
        requestId: operation.requestId,
        menuId: node.id,
        docUniqueId: input.docUniqueId,
        enabled: input.enabled,
        knowledgeSync: { status: "queued", taskId },
      };
    } catch (error) {
      throw partialError(error, operation, failedStage);
    }
  }

  async deleteDocument(input: DeleteDocumentInput) {
    const operation: OperationState = {
      requestId: requestId(input.requestId),
      completedStages: [],
      docUniqueId: input.docUniqueId,
      knowledgeTaskIds: [],
    };
    const context = await this.context(input.kb);
    assertPermission(context, "delete");

    const tree = await this.menuTree(context.kbId);
    const node = findDocumentNode(tree, input.docUniqueId);
    operation.menuId = node?.id;

    let failedStage = "delete_document";
    try {
      if (node) {
        // 级联删除子树 + 文档行(menu.service 复用;派生删除任务在其中生成)
        const docRows = await db
          .select({ id: documents.id })
          .from(documents)
          .where(eq(documents.menuId, node.id));
        for (const doc of docRows) {
          await syncWorkerService.enqueueDocumentSync(context.kbId, doc.id, "delete", true);
        }
        await db.delete(documents).where(eq(documents.menuId, node.id));
        await db.delete(menus).where(eq(menus.id, node.id));
        operation.completedStages.push("delete_document");
      } else {
        operation.completedStages.push("document_already_absent");
      }

      failedStage = "knowledge_sync_task";
      const taskId = await this.enqueueDelete({ context, docUniqueId: input.docUniqueId });
      operation.knowledgeTaskIds?.push(taskId);
      operation.completedStages.push("knowledge_sync_task");
      return {
        status: "success",
        requestId: operation.requestId,
        docUniqueId: input.docUniqueId,
        deletedAllLanguages: true,
        knowledgeSync: { status: "queued", taskIds: operation.knowledgeTaskIds },
      };
    } catch (error) {
      throw partialError(error, operation, failedStage);
    }
  }

  async createResourceUpload(input: CreateResourceUploadInput) {
    const currentRequestId = requestId(input.requestId);
    const context = await this.context(input.kb);
    if (input.docUniqueId) {
      assertPermission(context, "update");
      await this.resolveDocument(context, input.docUniqueId);
    } else {
      assertPermission(context, "create");
    }

    const contextId = input.docUniqueId ?? temporaryUploadContextId(currentRequestId);

    // Vercel Blob:服务端上传模型 —— 返回上传代理端点,调用方 PUT 文件字节后从响应读取最终 URL
    if (uploadMode() === "vercel-blob") {
      const fileName = input.fileName;
      const query = new URLSearchParams({
        fileName,
        contentType: input.contentType,
        contextId,
        ...(context.envCode && context.envCode !== "default"
          ? { envCode: context.envCode }
          : {}),
      });
      return {
        status: "ready",
        requestId: currentRequestId,
        uploadUrl: `/api/doc-platform/open/${encodeURIComponent(input.kb)}/oss/blob-upload?${query.toString()}`,
        method: "PUT",
        ossKey: objectPath(contextId, fileName),
        verification: "client_put_2xx_read_response",
        note: "Vercel Blob 模式:PUT 文件字节到 uploadUrl,响应 data.url 为最终资源地址",
      };
    }

    const upload = await createPresignedPut({
      fileName: input.fileName,
      fileSize: input.fileSize,
      contentType: input.contentType,
      contextId,
      envCode: context.envCode,
    });
    let readPath: string | undefined;
    if (upload.readUrl) {
      try {
        readPath = new URL(upload.readUrl).pathname;
      } catch {
        readPath = upload.readUrl;
      }
    }
    return {
      status: "ready",
      requestId: currentRequestId,
      uploadUrl: upload.uploadUrl,
      method: "PUT",
      ossKey: upload.key,
      readUrl: upload.readUrl,
      resourcePath: readPath ?? upload.key,
      verification: "client_put_2xx",
    };
  }
}

// ── 内部工具 ──

import { menus } from "../../db/index.js";

type OpenMenuRow = {
  id: string;
  parentId: string | null;
  previousId: string | null;
  name: string;
  type: string;
  iconUrl: string | null;
  slug: string | null;
  enable: number;
  docUniqueId: string | null;
};

/** dp 菜单行 → Open MenuNode 树(含禁用项;兄弟链表排序与 doc-platform 一致) */
function buildOpenTree(rows: OpenMenuRow[]): MenuNode[] {
  const byParent = new Map<string | null, OpenMenuRow[]>();
  for (const row of rows) {
    const key = row.parentId;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(row);
  }

  function build(parent: OpenMenuRow | null): MenuNode[] {
    const group = byParent.get(parent ? parent.id : null) ?? [];
    const inGroup = new Set(group.map((r) => r.id));
    const ordered: OpenMenuRow[] = [];
    const visited = new Set<string>();
    const heads = group.filter((r) => !r.previousId || !inGroup.has(r.previousId));
    for (const head of heads) {
      let cursor: OpenMenuRow | undefined = head;
      while (cursor && !visited.has(cursor.id)) {
        visited.add(cursor.id);
        ordered.push(cursor);
        cursor = group.find((r) => r.previousId === cursor!.id);
      }
    }
    for (const row of group) {
      if (!visited.has(row.id)) ordered.push(row);
    }

    return ordered.map((row) => ({
      id: row.id,
      name: row.name,
      type: (row.type === "folder" ? "folder" : "doc") as MenuNode["type"],
      iconUrl: row.iconUrl ?? undefined,
      slug: row.slug ?? undefined,
      enable: Number(row.enable) === 1,
      parentId: row.parentId ?? undefined,
      docUniqueId: row.docUniqueId ?? undefined,
      menuTrees: build(row),
    }));
  }

  return build(null);
}

/** 导出给 routes 复用(菜单树解析) */
export { DocPlatformError };
