import { z } from 'zod'

// 融合方法类型
export type FusionMethod = 'weighted' | 'rrf' | 'weighted-rrf' | 'hybrid'

// 分割策略类型
export type ChunkStrategy =
  | 'none'
  | 'recursive'
  | 'character'
  | 'token'
  | 'markdown'
  | 'semantic-markdown'
  | 'llm-semantic'  // 基于 LLM 的语义分割
  | 'html'
  | 'json'
  | 'latex'
  | 'sentence'

// 分割配置（根据策略不同，参数不同）
export interface ChunkConfig {
  // recursive, character, sentence 等策略通用参数
  maxSize?: number
  minSize?: number
  overlap?: number
  separators?: string[]
  // token 策略参数
  maxTokens?: number
  overlapTokens?: number
  // semantic-markdown 策略参数
  joinThreshold?: number
  modelName?: string
  // llm-semantic 策略参数
  llmModel?: string  // LLM 模型名称，默认 'gpt-4o-mini'
  customPrompt?: string  // 自定义提示词（可选）
  // sentence 策略参数
  sentenceEnders?: string[]
  keepSeparator?: boolean
}

// 知识库实体
export interface KnowledgeBase {
  id: string
  name: string
  description?: string
  embeddingModel: string
  defaultChunkStrategy: ChunkStrategy
  defaultChunkConfig?: ChunkConfig
  // 索引相关字段
  indexName?: string
  indexDimension?: number
  indexCreated?: boolean
  indexCreatedAt?: Date
  // 统计信息
  documentCount?: number
  chunkCount?: number
  createdAt: Date
  updatedAt: Date
}

// 文档状态类型
export type DocumentStatus = 'processing' | 'completed' | 'failed'

// 文档实体
export interface Document {
  id: string
  knowledgeBaseId: string
  content: string
  type: 'text' | 'markdown' | 'html' | 'tiptap'
  chunkStrategy: ChunkStrategy
  chunkConfig?: ChunkConfig
  metadata?: Record<string, any>
  chunkCount: number
  status?: DocumentStatus
  createdAt: Date
  updatedAt: Date
}

// 创建知识库请求
export const CreateKnowledgeBaseRequestSchema = z.object({
  id: z.string().optional(), // 支持自定义ID
  name: z.string().min(1),
  description: z.string().optional(),
  embeddingModel: z.string().optional().default('openai/text-embedding-3-small'),
  defaultChunkStrategy: z
    .enum([
      'none',
      'recursive',
      'character',
      'token',
      'markdown',
      'semantic-markdown',
      'llm-semantic',
      'html',
      'json',
      'latex',
      'sentence'
    ])
    .optional()
    .default('recursive'),
  defaultChunkConfig: z.any().optional()
})

export type CreateKnowledgeBaseRequest = z.infer<typeof CreateKnowledgeBaseRequestSchema>

// 添加文档请求
export const AddDocumentRequestSchema = z.object({
  id: z.string().optional(),
  content: z.string().optional(),
  url: z.string().url().optional(),
  type: z.enum(['text', 'markdown', 'html', 'tiptap']).optional().default('text'),
  chunkStrategy: z
    .enum([
      'none',
      'recursive',
      'character',
      'token',
      'markdown',
      'semantic-markdown',
      'llm-semantic',
      'html',
      'json',
      'latex',
      'sentence'
    ])
    .optional(),
  chunkConfig: z.any().optional(),
  metadata: z.record(z.string(), z.any()).optional()
})

export type AddDocumentRequest = z.infer<typeof AddDocumentRequestSchema>

// 更新文档请求
export const UpdateDocumentRequestSchema = z.object({
  content: z.string().optional(),
  url: z.string().url().optional(),
  type: z.enum(['text', 'markdown', 'html', 'tiptap']).optional(),
  chunkStrategy: z
    .enum([
      'none',
      'recursive',
      'character',
      'token',
      'markdown',
      'semantic-markdown',
      'llm-semantic',
      'html',
      'json',
      'latex',
      'sentence'
    ])
    .optional(),
  chunkConfig: z.any().optional(),
  metadata: z.record(z.string(), z.any()).optional()
})

export type UpdateDocumentRequest = z.infer<typeof UpdateDocumentRequestSchema>

// 元数据过滤类型（支持 MongoDB 风格查询语法）
// 支持的运算符：
// - 比较运算符：$eq, $ne, $gt, $gte, $lt, $lte
// - 数组运算符：$in, $nin, $all, $elemMatch
// - 逻辑运算符：$and, $or, $not, $nor
// - 元素运算符：$exists
// - 自定义运算符：$contains, $regex, $size
// 示例：
// { category: "electronics" }
// { price: { $gt: 100 } }
// { tags: { $in: ["sale", "new"] } }
// { $or: [{ category: "electronics" }, { category: "accessories" }] }
export type MetadataFilter = Record<string, any>

// 检索请求
export const SearchRequestSchema = z
  .object({
    // metadata 检索（纯元信息召回）可省略 query；其余检索类型必填
    query: z.string().min(1).optional(),
    topK: z.number().int().positive().optional().default(10),
    filter: z.any().optional() as z.ZodType<MetadataFilter | undefined>, // 支持 MongoDB 风格查询语法
    searchType: z.enum(['semantic', 'keyword', 'hybrid', 'metadata']).optional().default('semantic'),
  hybridWeight: z
    .object({
      semantic: z.number().min(0).max(1).optional(),
      keyword: z.number().min(0).max(1).optional()
    })
    .optional(),
  fusionMethod: z
    .enum(['weighted', 'rrf', 'weighted-rrf', 'hybrid'])
    .optional()
    .describe('Fusion method for hybrid search: weighted (legacy), rrf (recommended 2025), weighted-rrf, hybrid'),
  rrfK: z
    .number()
    .int()
    .positive()
    .optional()
    .default(60)
    .describe('RRF parameter k (default 60, usually no need to change)'),
  recallConfig: z
    .object({
      recallTopK: z.number().int().positive().optional().default(50),
      enableQueryExpansion: z.boolean().optional().default(false),
      enableMultiStage: z.boolean().optional().default(true)
    })
    .optional(),
  rerankConfig: z
    .object({
      enableRerank: z.boolean().optional().default(true),
      rerankTopK: z.number().int().positive().optional().default(20),
      rerankModel: z.enum(['llm', 'mastra', 'cohere', 'zeroentropy', 'simple']).optional().default('llm')
    })
    .optional(),
  // HyDE 配置（假设性文档嵌入）
  hydeConfig: z
    .object({
      enableHyDE: z.boolean().optional().default(false).describe('Enable HyDE (Hypothetical Document Embeddings) retrieval'),
      llmModel: z.string().optional().default('gpt-4o-mini').describe('LLM model for generating hypothetical documents'),
      embeddingModel: z.string().optional().describe('Embedding model (default: knowledge base default)')
    })
    .optional()
    .describe('HyDE improves recall by 15-20% for abstract/ambiguous queries'),
  // 多查询检索配置
  multiQueryConfig: z
    .object({
      enableMultiQuery: z.boolean().optional().default(false).describe('Enable multi-query retrieval'),
      numVariations: z.number().int().min(1).max(10).optional().default(3).describe('Number of query variations (3-5 recommended)'),
      llmModel: z.string().optional().default('gpt-4o-mini').describe('LLM model for generating query variations')
    })
    .optional()
    .describe('Multi-query retrieval improves recall by 20-30% for complex queries'),
  pgVectorConfig: z
    .object({
      minScore: z.number().min(0).max(1).optional(), // 最小相似度阈值，过滤低质量结果
      ef: z.number().int().positive().optional(), // HNSW 搜索参数，控制搜索精度和速度
      probes: z.number().int().positive().optional() // IVFFlat 搜索参数，控制搜索范围
    })
    .optional()
  })
  .superRefine((val, ctx) => {
    // 能力开关由调用方决定：metadata 检索走纯元信息召回（filter 必填），其余类型必填 query
    if (val.searchType === 'metadata') {
      if (!val.filter || Object.keys(val.filter).length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['filter'], message: 'metadata search requires a non-empty filter' })
      }
    } else if (!val.query) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['query'], message: 'query is required for semantic/keyword/hybrid search' })
    }
  })

export type SearchRequest = z.infer<typeof SearchRequestSchema>

// 检索结果项
export interface SearchResultItem {
  id: string
  text: string
  score: number
  metadata: Record<string, any>
  documentId: string
  chunkIndex?: number
}

// 检索响应
export interface SearchResponse {
  results: SearchResultItem[]
  total: number
  searchType: 'semantic' | 'keyword' | 'hybrid'
  recallStage?: string
  reranked?: boolean
}
