import { Hono } from 'hono';
import { z } from "zod";
import {
  knowledgeBaseService,
  syncTaskService,
  documentSyncService,
} from "../services";
import type { SyncTaskConfig } from "../services/sync-task.service";
import { normalizeIndexName } from "../../../utils/index-name.js";

/**
 * 默认嵌入模型（固定使用 OpenAI text-embedding-3-small）
 */
const DEFAULT_EMBEDDING_MODEL = "openai/text-embedding-3-small";
const EMBEDDING_DIMENSION = 1536;

/**
 * 同步请求参数Schema
 */
const SyncFromYydocRequestSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  brandCode: z.string().optional().default("rpa"),
  languageCode: z.string().optional().default("zh-CN"),
  chunkStrategy: z.string().optional(),
  chunkConfig: z.any().optional(),
  maxDocs: z.number().int().positive().optional(), // 最大文档数量限制（用于测试）
});

/**
 * 指定文档ID同步请求参数Schema
 */
const SyncDocumentFromYydocRequestSchema = z.object({
  brandCode: z.string().min(1),
  languageCode: z.string().min(1),
  docIds: z.array(z.string().min(1)).min(1), // 至少一个文档ID
  chunkStrategy: z.string().optional(),
  chunkConfig: z.any().optional(),
});

const DocPlatformSyncOperationSchema = z.enum([
  "upsertDocument",
  "deleteDocument",
  "batchUpsertDocuments",
  "batchDeleteDocuments",
]);

const DocPlatformSyncDocumentSchema = z.object({
  docUniqueId: z.string().min(1),
  menuId: z.string().optional(),
  name: z.string().optional(),
  content: z.any().optional(),
  force: z.boolean().optional(),
  docPath: z.string().optional(),
  parentPath: z.string().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
});

const SyncFromDocPlatformRequestSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  brandCode: z.string().min(1),
  languageCode: z.string().min(1),
  operation: DocPlatformSyncOperationSchema,
  documents: z.array(DocPlatformSyncDocumentSchema).min(1),
  chunkStrategy: z.string().optional(),
  chunkConfig: z.any().optional(),
});

async function ensureKnowledgeBaseForSync(params: {
  knowledgeBaseId: string;
  name: string;
  description?: string;
  chunkStrategy?: string;
  chunkConfig?: any;
}) {
  let existingKb = await knowledgeBaseService.getKnowledgeBase(
    params.knowledgeBaseId,
  );

  if (!existingKb) {
    const defaultChunkConfig = {
      maxSize: 512,
      overlap: 50,
    };

    const createRequest: any = {
      id: params.knowledgeBaseId,
      name: params.name,
      embeddingModel: DEFAULT_EMBEDDING_MODEL,
      defaultChunkStrategy: (params.chunkStrategy || "markdown") as any,
      defaultChunkConfig: params.chunkConfig || defaultChunkConfig,
    };

    if (params.description) {
      createRequest.description = params.description;
    }

    try {
      existingKb =
        await knowledgeBaseService.createKnowledgeBase(createRequest);
    } catch (error: any) {
      // 并发创建同一个知识库时，后到的请求可能命中主键冲突；重新读取即可。
      existingKb = await knowledgeBaseService.getKnowledgeBase(
        params.knowledgeBaseId,
      );
      if (!existingKb) {
        throw error;
      }
    }
  }

  await knowledgeBaseService.ensureKnowledgeBaseReady(params.knowledgeBaseId);
  return existingKb;
}

/**
 * 从影刀文档系统同步文档
 * POST /knowledge-base/sync-from-yydoc
 */
export const syncFromYydoc = new Hono().post('/sync-from-yydoc', async (c) => {
    try {
      const body = await c.req.json();
      const validated = SyncFromYydocRequestSchema.parse(body);

      // 1. 生成知识库ID：kb_${brandCode}_${languageCode}（规范化，连字符替换为下划线）
      const normalizedBrandCode = normalizeIndexName(validated.brandCode);
      const normalizedLanguageCode = normalizeIndexName(
        validated.languageCode,
      );
      const knowledgeBaseId = `kb_${normalizedBrandCode}_${normalizedLanguageCode}`;

      // 2. 检查知识库是否已存在
      let existingKb =
        await knowledgeBaseService.getKnowledgeBase(knowledgeBaseId);

      // 3. 如果不存在，创建新知识库
      // 对于markdown文档，默认使用markdown分块策略
      if (!existingKb) {
        // 默认分块配置
        const defaultChunkConfig = {
          maxSize: 512,
          overlap: 50,
        };

        const createRequest: any = {
          id: knowledgeBaseId,
          name: validated.name,
          embeddingModel: DEFAULT_EMBEDDING_MODEL,
          defaultChunkStrategy: (validated.chunkStrategy ||
            "markdown") as any,
          defaultChunkConfig: validated.chunkConfig || defaultChunkConfig,
        };

        if (validated.description) {
          createRequest.description = validated.description;
        }

        existingKb =
          await knowledgeBaseService.createKnowledgeBase(createRequest);
      }

      // 4. 创建同步任务配置
      const taskConfig: SyncTaskConfig = {
        brandCode: validated.brandCode,
        languageCode: validated.languageCode,
        operation: "syncFromYydoc",
        chunkStrategy: validated.chunkStrategy,
        chunkConfig: validated.chunkConfig,
        maxDocs: validated.maxDocs,
      };

      // 5. 确保知识库向量索引已就绪
      try {
        await knowledgeBaseService.ensureKnowledgeBaseReady(knowledgeBaseId);
      } catch (error: any) {
        return c.json(
          {
            code: 500,
            success: false,
            message: `Failed to prepare knowledge base: ${error.message}`,
            data: null,
          },
          500,
        );
      }

      // 6. 创建同步任务
      const taskId = await syncTaskService.createTask(
        knowledgeBaseId,
        taskConfig,
      );

      // 7. 后台异步执行同步（不阻塞）
      documentSyncService
        .syncDocumentsFromYingdao(taskId, knowledgeBaseId, taskConfig)
        .catch((error) => {
          console.error("Background sync failed:", error);
          // 错误已在syncDocumentsFromYingdao中处理，这里只记录日志
        });

      // 8. 立即返回任务ID
      return c.json({
        code: 200,
        success: true,
        message: "Sync task created successfully",
        data: {
          taskId,
          knowledgeBaseId,
          status: "pending",
        },
      });
    } catch (error: any) {
      return c.json(
        {
          code: 400,
          success: false,
          message: error.message || "Failed to create sync task",
          data: null,
        },
        400,
      );
    }
  });

/**
 * 从影刀文档系统同步指定文档
 * POST /knowledge-base/sync-document-from-yydoc
 */
export const syncDocumentFromYydoc = new Hono().post('/sync-document-from-yydoc', async (c) => {
    try {
      const body = await c.req.json();
      const validated = SyncDocumentFromYydocRequestSchema.parse(body);

      // 1. 生成知识库ID：kb_${brandCode}_${languageCode}（规范化，连字符替换为下划线）
      const normalizedBrandCode = normalizeIndexName(validated.brandCode);
      const normalizedLanguageCode = normalizeIndexName(
        validated.languageCode,
      );
      const knowledgeBaseId = `kb_${normalizedBrandCode}_${normalizedLanguageCode}`;

      // 2. 检查知识库是否已存在
      let existingKb =
        await knowledgeBaseService.getKnowledgeBase(knowledgeBaseId);

      // 3. 如果不存在，创建新知识库
      if (!existingKb) {
        // 默认分块配置
        const defaultChunkConfig = {
          maxSize: 512,
          overlap: 50,
        };

        const createRequest: any = {
          id: knowledgeBaseId,
          name: `知识库 ${validated.brandCode} ${validated.languageCode}`,
          embeddingModel: DEFAULT_EMBEDDING_MODEL,
          defaultChunkStrategy: (validated.chunkStrategy ||
            "markdown") as any,
          defaultChunkConfig: validated.chunkConfig || defaultChunkConfig,
        };

        existingKb =
          await knowledgeBaseService.createKnowledgeBase(createRequest);
      }

      // 4. 创建同步任务配置
      const taskConfig: SyncTaskConfig = {
        brandCode: validated.brandCode,
        languageCode: validated.languageCode,
        operation: "syncYydocDocuments",
        chunkStrategy: validated.chunkStrategy,
        chunkConfig: validated.chunkConfig,
      };

      // 5. 确保知识库向量索引已就绪
      try {
        await knowledgeBaseService.ensureKnowledgeBaseReady(knowledgeBaseId);
      } catch (error: any) {
        return c.json(
          {
            code: 500,
            success: false,
            message: `Failed to prepare knowledge base: ${error.message}`,
            data: null,
          },
          500,
        );
      }

      // 6. 创建同步任务
      const taskId = await syncTaskService.createTask(
        knowledgeBaseId,
        taskConfig,
      );

      // 7. 后台异步执行同步（不阻塞）
      documentSyncService
        .syncDocumentsByIds(
          taskId,
          knowledgeBaseId,
          validated.docIds,
          taskConfig,
        )
        .catch((error) => {
          console.error("Background sync by IDs failed:", error);
          // 错误已在syncDocumentsByIds中处理，这里只记录日志
        });

      // 8. 立即返回任务ID
      return c.json({
        code: 200,
        success: true,
        message: "Sync task created successfully",
        data: {
          taskId,
          knowledgeBaseId,
          docIds: validated.docIds,
          status: "pending",
        },
      });
    } catch (error: any) {
      return c.json(
        {
          code: 400,
          success: false,
          message: error.message || "Failed to create sync task",
          data: null,
        },
        400,
      );
    }
  });

/**
 * 从文档平台触发知识库同步任务。
 * POST /knowledge-base/sync-from-doc-platform
 */
export const syncFromDocPlatform = new Hono().post('/sync-from-doc-platform', async (c) => {
    try {
      const body = await c.req.json();
      const validated = SyncFromDocPlatformRequestSchema.parse(body);

      const normalizedBrandCode = normalizeIndexName(validated.brandCode);
      const normalizedLanguageCode = normalizeIndexName(
        validated.languageCode,
      );
      const knowledgeBaseId = `kb_${normalizedBrandCode}_${normalizedLanguageCode}`;

      try {
        await ensureKnowledgeBaseForSync({
          knowledgeBaseId,
          name:
            validated.name ||
            `${validated.brandCode}-${validated.languageCode}`,
          description: validated.description,
          chunkStrategy: validated.chunkStrategy,
          chunkConfig: validated.chunkConfig,
        });
      } catch (error: any) {
        return c.json(
          {
            code: 500,
            success: false,
            message: `Failed to prepare knowledge base: ${error.message}`,
            data: null,
          },
          500,
        );
      }

      const taskConfig: SyncTaskConfig = {
        brandCode: validated.brandCode,
        languageCode: validated.languageCode,
        operation: validated.operation,
        chunkStrategy: validated.chunkStrategy,
        chunkConfig: validated.chunkConfig,
        documents: validated.documents,
      };

      const taskId = await syncTaskService.createTask(
        knowledgeBaseId,
        taskConfig,
      );

      documentSyncService
        .syncDocumentsFromDocPlatform(taskId, knowledgeBaseId, taskConfig)
        .catch((error) => {
          console.error("Background doc-platform sync failed:", error);
        });

      return c.json({
        code: 200,
        success: true,
        message: "Sync task created successfully",
        data: {
          taskId,
          knowledgeBaseId,
          operation: validated.operation,
          documentCount: validated.documents.length,
          status: "pending",
        },
      });
    } catch (error: any) {
      return c.json(
        {
          code: 400,
          success: false,
          message: error.message || "Failed to create doc-platform sync task",
          data: null,
        },
        400,
      );
    }
  });
