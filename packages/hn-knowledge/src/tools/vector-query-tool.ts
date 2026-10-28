/**
 * 知识库向量检索工具（普通异步函数形态）。
 *
 * 由源工程 @mastra/rag createVectorQueryTool 改写而来，保持其 execute 语义：
 *   embedding 查询文本 → 向量库 topK 检索（minScore 0.7 / ef 200 / probes 10）→ 格式化结果。
 * 输入从 tool 的 queryText/topK/filter 改为显式 params，indexName 由 knowledgeBaseId 内部解析。
 */
import { embed } from 'ai'
import { vectorService } from '../rag/knowledge-base/index.js'
import { createEmbeddingModel } from '../providers/llm.js'
import { formatVectorResults } from '../utils/search-helper.js'
import type { SearchResultItem } from '../rag/knowledge-base/index.js'

/** 源 createVectorQueryTool 的 pgvector 默认配置 */
export const VECTOR_QUERY_DEFAULTS = {
  minScore: 0.7,
  ef: 200,
  probes: 10,
  topK: 10
} as const

export interface QueryKnowledgeBaseVectorsParams {
  /** 知识库 ID（内部解析为 pgvector 索引名） */
  knowledgeBaseId: string
  /** 查询文本 */
  query: string
  /** 返回结果数量，默认 10 */
  topK?: number
  /** 元数据过滤条件（MongoDB 风格） */
  filter?: Record<string, any>
  /** 低分过滤阈值，默认 0.7 */
  minScore?: number
  /** HNSW 搜索参数，默认 200 */
  ef?: number
  /** IVFFlat 搜索参数，默认 10 */
  probes?: number
  /** 嵌入模型名称（如 openai/text-embedding-3-small），默认取环境默认模型 */
  embeddingModel?: string
}

export interface QueryKnowledgeBaseVectorsResult {
  /** 检索结果（text/metadata/score/documentId/chunkIndex） */
  results: SearchResultItem[]
  /** 结果总数 */
  total: number
}

/**
 * 查询指定知识库的向量库（替代 createVectorQueryTool）。
 */
export async function queryKnowledgeBaseVectors(
  params: QueryKnowledgeBaseVectorsParams
): Promise<QueryKnowledgeBaseVectorsResult> {
  const { knowledgeBaseId, query, filter } = params
  const topK = params.topK ?? VECTOR_QUERY_DEFAULTS.topK
  const pgVectorConfig = {
    minScore: params.minScore ?? VECTOR_QUERY_DEFAULTS.minScore,
    ef: params.ef ?? VECTOR_QUERY_DEFAULTS.ef,
    probes: params.probes ?? VECTOR_QUERY_DEFAULTS.probes
  }

  // 生成查询向量
  const embeddingModel = createEmbeddingModel(params.embeddingModel || 'openai/text-embedding-3-small')
  const { embedding } = await embed({ value: query, model: embeddingModel })

  // 向量检索
  const vectorResults = await vectorService.query(knowledgeBaseId, embedding, topK, filter, pgVectorConfig)

  // 格式化（与源 tool 的 sources 输出对齐：text / metadata / score / documentId）
  const results = formatVectorResults(vectorResults)
  return { results, total: results.length }
}
