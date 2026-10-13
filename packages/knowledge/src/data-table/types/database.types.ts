import { z } from "zod";
import type {
  ChunkStrategy,
  ChunkConfig,
} from "../../rag/knowledge-base/index.js";

export const DATABASE_COLUMN_TYPES = [
  "text",
  "varchar",
  "integer",
  "bigint",
  "boolean",
  "jsonb",
  "timestamp",
  "double",
] as const;

export type DatabaseColumnType = (typeof DATABASE_COLUMN_TYPES)[number];

export interface DatabaseColumnDefinition {
  name: string;
  length?: number;
  notNull?: boolean;
}

export interface DatabaseDefinition {
  id: string;
  name: string;
  description?: string;
  embeddingModel: string;
  defaultChunkStrategy: ChunkStrategy;
  defaultChunkConfig?: ChunkConfig;
  indexName?: string;
  indexDimension?: number;
  indexCreated?: boolean;
  indexCreatedAt?: Date;
  dataTableName: string;
  columnDefinitions: DatabaseColumnDefinition[];
  rowCount?: number;
  createdAt: Date;
  updatedAt: Date;
}

/** 与 assertSafeIdentifier 一致；允许 camelCase / PascalCase（首字符须为字母） */
const columnNameRegex = /^[a-zA-Z][a-zA-Z0-9_]{0,62}$/;

export const ROWS_SEARCH_DEFAULT_TOP_K = 200;
export const ROWS_SEARCH_MAX_TOP_K = 200;
export const ROWS_SEARCH_DEFAULT_FILTER_LIMIT = 200;
export const ROWS_SEARCH_MAX_FILTER_LIMIT = 200;

export const DatabaseColumnDefinitionSchema = z
  .object({
    name: z.string().regex(columnNameRegex, "Invalid column name"),
    length: z.number().int().min(1).max(4000).optional(),
    notNull: z.boolean().optional(),
  })
  .superRefine((col, ctx) => {
    const reserved = new Set(["id", "created_at", "updated_at"]);
    if (reserved.has(col.name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Column name "${col.name}" is reserved`,
      });
    }
  });

export const CreateDatabaseRequestSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  columns: z.array(DatabaseColumnDefinitionSchema).min(1),
  /** 建表并创建向量索引后，按列定义批量写入初始行（键与 columns.name 对应） */
  dataSource: z.array(z.record(z.string(), z.unknown())).max(5000).optional(),
  embeddingModel: z
    .string()
    .optional()
    .default("openai/text-embedding-3-small"),
  defaultChunkStrategy: z
    .enum([
      "none",
      "recursive",
      "character",
      "token",
      "markdown",
      "semantic-markdown",
      "llm-semantic",
      "html",
      "json",
      "latex",
      "sentence",
    ])
    .optional()
    .default("recursive"),
  defaultChunkConfig: z.any().optional(),
});

export type CreateDatabaseRequest = z.infer<typeof CreateDatabaseRequestSchema>;

export const UpdateDatabaseRequestSchema = z
  .object({
    columns: z.array(DatabaseColumnDefinitionSchema).min(1),
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
  })
  .superRefine((data, ctx) => {
    const names = data.columns.map((c) => c.name);
    if (new Set(names).size !== names.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "columns must have unique names",
      });
    }
  });

export type UpdateDatabaseRequest = z.infer<typeof UpdateDatabaseRequestSchema>;

/** POST /database/:id/rows 批量写入：rows 为行对象数组（与动态表列对应，无单独 metadata 列） */
export const BatchRowsMetadataRequestSchema = z.object({
  rows: z.array(z.record(z.string(), z.unknown())).min(1),
});

export type BatchRowsMetadataRequest = z.infer<
  typeof BatchRowsMetadataRequestSchema
>;

/** PATCH /database/:id/rows/batch */
export const BatchRowsUpdateRequestSchema = z
  .object({
    items: z
      .array(
        z.object({
          id: z.string().min(1),
          patch: z.record(z.string(), z.unknown()),
        }),
      )
      .min(1)
      .max(200),
  })
  .superRefine((data, ctx) => {
    const ids = data.items.map((x) => x.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "items must have unique id values",
      });
    }
  });

export type BatchRowsUpdateRequest = z.infer<
  typeof BatchRowsUpdateRequestSchema
>;

/** DELETE /database/:id/rows/batch */
export const BatchRowsDeleteRequestSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(200),
});

export type BatchRowsDeleteRequest = z.infer<
  typeof BatchRowsDeleteRequestSchema
>;

export const UpsertVectorsRequestSchema = z.object({
  vectors: z.array(z.array(z.number())).min(1),
  metadata: z.array(z.record(z.string(), z.unknown())).min(1),
  ids: z.array(z.string()).optional(),
});

export const QueryVectorsRequestSchema = z.object({
  queryVector: z.array(z.number()).min(1),
  topK: z.number().int().min(1).max(500).optional().default(10),
  filter: z.record(z.string(), z.unknown()).optional(),
  minScore: z.number().optional(),
  ef: z.number().optional(),
  probes: z.number().optional(),
});

/** 兼容旧请求：body.query 为对象时视为 filter */
function preprocessRowsSearchBody(val: unknown): unknown {
  if (!val || typeof val !== "object" || Array.isArray(val)) return val;
  const o = { ...(val as Record<string, unknown>) };
  const q = o.query;
  if (
    q !== undefined &&
    typeof q === "object" &&
    q !== null &&
    !Array.isArray(q)
  ) {
    o.filter = q;
    delete o.query;
  }
  if (o.selectFields === undefined && Array.isArray(o.fields)) {
    o.selectFields = o.fields;
  }
  if (o.selectFields === undefined && Array.isArray(o.returnFields)) {
    o.selectFields = o.returnFields;
  }
  return o;
}

/**
 * query：检索文本（可选；语义/关键词/混合时必填）
 * filter：列过滤（可选，与 create 列一致；服务端拼 WHERE，见 searchRowsByFilter）
 * 二者至少其一；若同时提供则先 SQL 过滤再在结果集上做检索（与 knowledge-base 组合过滤语义一致：先结构化筛选再检索）
 *
 * 向量侧为「行文本按数据集 defaultChunkStrategy 分块」后的 chunk；返回项的 text/metadata.text 为命中块内容，id 为 chunk 向量 id，metadata.rowId 为所属行。
 * selectFields：可选返回字段白名单；例如 ['title', 'description'] 时，返回项 row 仅包含这两个字段（不存在的字段会被忽略）。
 *
 * searchType / hybridWeight / recallConfig / rerankConfig 等与 knowledge-base SearchRequest 对齐；仅在提供 query 时生效
 */
export const RowsSearchRequestSchema = z.preprocess(
  preprocessRowsSearchBody,
  z
    .object({
      query: z.string().min(1).optional(),
      filter: z.record(z.string(), z.unknown()).optional(),
      topK: z
        .number()
        .int()
        .positive()
        .max(ROWS_SEARCH_MAX_TOP_K)
        .optional()
        .default(ROWS_SEARCH_DEFAULT_TOP_K),
      minScore: z.number().optional(),
      ef: z.number().optional(),
      probes: z.number().optional(),
      selectFields: z
        .array(
          z.string().trim().regex(columnNameRegex, "Invalid select field name"),
        )
        .min(1)
        .max(200)
        .optional(),
      limit: z
        .number()
        .int()
        .min(1)
        .max(ROWS_SEARCH_MAX_FILTER_LIMIT)
        .optional()
        .default(ROWS_SEARCH_DEFAULT_FILTER_LIMIT),
      searchType: z
        .enum(["semantic", "keyword", "hybrid"])
        .optional()
        .default("semantic"),
      hybridWeight: z
        .object({
          semantic: z.number().min(0).max(1).optional(),
          keyword: z.number().min(0).max(1).optional(),
        })
        .optional(),
      fusionMethod: z
        .enum(["weighted", "rrf", "weighted-rrf", "hybrid"])
        .optional(),
      rrfK: z.number().int().positive().optional().default(60),
      recallConfig: z
        .object({
          recallTopK: z.number().int().positive().optional(),
          enableQueryExpansion: z.boolean().optional().default(false),
          enableMultiStage: z.boolean().optional().default(true),
        })
        .optional(),
      rerankConfig: z
        .object({
          enableRerank: z.boolean().optional().default(true),
          rerankTopK: z
            .number()
            .int()
            .positive()
            .optional()
            .default(ROWS_SEARCH_DEFAULT_TOP_K),
          rerankModel: z
            .enum(["mastra", "cohere", "zeroentropy", "simple"])
            .optional()
            .default("simple"),
        })
        .optional(),
      hydeConfig: z
        .object({
          enableHyDE: z.boolean().optional().default(false),
          llmModel: z.string().optional().default("gpt-4o-mini"),
          embeddingModel: z.string().optional(),
        })
        .optional(),
      multiQueryConfig: z
        .object({
          enableMultiQuery: z.boolean().optional().default(false),
          numVariations: z.number().int().min(1).max(10).optional().default(3),
          llmModel: z.string().optional().default("gpt-4o-mini"),
        })
        .optional(),
      pgVectorConfig: z
        .object({
          minScore: z.number().min(0).max(1).optional(),
          ef: z.number().int().positive().optional(),
          probes: z.number().int().positive().optional(),
        })
        .optional(),
    })
    .superRefine((data, ctx) => {
      const hasQuery =
        data.query != null && String(data.query).trim().length > 0;
      const hasFilter =
        data.filter != null && Object.keys(data.filter).length > 0;
      if (!hasQuery && !hasFilter) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Provide at least one of: query (non-empty string) or filter (non-empty object)",
        });
      }
    }),
);

export type RowsSearchRequest = z.infer<typeof RowsSearchRequestSchema>;
