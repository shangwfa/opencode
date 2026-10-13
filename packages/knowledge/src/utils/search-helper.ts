import { embed } from 'ai'
import { openaiEmbedding } from '../providers/llm.js'
import type { VectorService } from '../rag/knowledge-base/index.js'
import type { SearchResultItem } from '../rag/knowledge-base/index.js'
import {
  MIN_RELEVANCE_SCORE,
  MIN_SEMANTIC_SCORE,
  RECALL_MULTIPLIER
} from '../config/search.constants'

/**
 * 根据嵌入模型名称创建嵌入模型实例
 */
export function createEmbeddingModel(embeddingModel: string): any {
  if (embeddingModel.startsWith('openai/')) {
    const modelName = embeddingModel.replace('openai/', '')
    return openaiEmbedding(modelName)
  } else {
    return openaiEmbedding(embeddingModel)
  }
}

/**
 * 格式化向量检索结果为统一的 SearchResultItem 格式
 *
 * @param results 向量检索结果
 * @returns 格式化后的搜索结果
 */
export function formatVectorResults(results: any[]): SearchResultItem[] {
  return results.map((result) => {
    const text = result.metadata?.text || ''
    return {
      id: result.id,
      text,
      score: result.score || 0,
      metadata: {
        ...result.metadata,
        text // 确保 metadata.text 存在，符合 Mastra 要求
      },
      documentId: result.metadata?.documentId || '',
      chunkIndex: result.metadata?.chunkIndex
    }
  })
}

/**
 * 过滤低分结果
 *
 * @param results 搜索结果
 * @param minScore 最低分数阈值
 * @param searchType 搜索类型
 * @returns 过滤后的结果
 */
export function filterLowScoreResults(
  results: SearchResultItem[],
  minScore?: number,
  searchType: 'semantic' | 'keyword' | 'hybrid' = 'semantic'
): SearchResultItem[] {
  // 如果没有指定阈值，使用默认值
  const threshold = minScore ?? getDefaultMinScore(searchType)

  return results.filter(result => result.score >= threshold)
}

/**
 * 获取默认最低分数阈值
 *
 * 统一返回 MIN_RELEVANCE_SCORE：修复前按 searchType 区分阈值（0.2/0.1/0.15），
 * 该设计假设 score 恒为相似度量级；hybrid 融合一旦产生 RRF 排名分（量级 ≈0.016）
 * 即被误杀（中文长句 keyword 0 命中场景必空）。现在三种 searchType 的对外 score
 * 均保证为绝对语义分（召回相似度 / LLM 相关性），共用统一质量阈值。
 *
 * @param _searchType 搜索类型（保留参数兼容旧签名；阈值已统一）
 * @returns 默认最低分数
 */
function getDefaultMinScore(_searchType: 'semantic' | 'keyword' | 'hybrid'): number {
  return MIN_RELEVANCE_SCORE
}

/**
 * 生成查询向量
 *
 * @param query 查询文本
 * @param embeddingModelName 嵌入模型名称
 * @returns 查询向量
 */
export async function generateQueryEmbedding(
  query: string,
  embeddingModelName?: string
): Promise<number[]> {
  const modelName = embeddingModelName || 'openai/text-embedding-3-small'
  const embeddingModel = createEmbeddingModel(modelName)
  const { embedding } = await embed({
    value: query,
    model: embeddingModel
  })
  return embedding
}

/**
 * 语义检索（提取公共方法）
 *
 * @param knowledgeBaseId 知识库ID
 * @param query 查询文本
 * @param topK 召回数量
 * @param filter 过滤条件
 * @param pgVectorConfig pgVector 配置
 * @param embeddingModelName 嵌入模型名称
 * @param vectorService 向量服务实例
 * @returns 搜索结果
 */
export async function semanticSearch(
  knowledgeBaseId: string,
  query: string,
  topK: number,
  vectorService: VectorService,
  filter?: Record<string, any>,
  pgVectorConfig?: { minScore?: number; ef?: number; probes?: number },
  embeddingModelName?: string
): Promise<SearchResultItem[]> {
  // 生成查询向量
  const embedding = await generateQueryEmbedding(query, embeddingModelName)

  // 查询向量数据库
  const vectorResults = await vectorService.query(
    knowledgeBaseId,
    embedding,
    topK,
    filter,
    pgVectorConfig
  )

  // 格式化结果
  const results = formatVectorResults(vectorResults)

  // 过滤低分结果
  const minScore = pgVectorConfig?.minScore ?? MIN_SEMANTIC_SCORE
  return filterLowScoreResults(results, minScore, 'semantic')
}

/**
 * 验证召回配置
 *
 * @param topK 请求的 topK
 * @param recallTopK 召回 topK
 * @throws 如果配置无效
 */
export function validateRecallConfig(topK: number, recallTopK?: number): void {
  if (topK < 1) {
    throw new Error('topK must be at least 1')
  }

  if (recallTopK !== undefined) {
    if (recallTopK < 10 || recallTopK > 200) {
      throw new Error(`recallTopK must be between 10 and 200, got ${recallTopK}`)
    }

    if (recallTopK < topK * RECALL_MULTIPLIER) {
      console.warn(
        `recallTopK (${recallTopK}) is less than recommended topK * ${RECALL_MULTIPLIER} (${topK * RECALL_MULTIPLIER}). ` +
        `This may limit reranking effectiveness.`
      )
    }
  }
}

/**
 * 检查搜索结果质量并返回提示信息
 *
 * @param results 搜索结果
 * @param topK 请求的结果数量
 * @returns 质量检查结果
 */
export interface QualityCheckResult {
  isHighQuality: boolean
  message?: string
  filteredCount: number
}

export function checkResultQuality(
  results: SearchResultItem[],
  topK: number,
  searchType: 'semantic' | 'keyword' | 'hybrid' = 'semantic'
): QualityCheckResult {
  const threshold = getDefaultMinScore(searchType)
  const highQualityResults = results.filter(r => r.score >= threshold)
  const filteredCount = results.length - highQualityResults.length

  // 如果返回结果少于请求数量的一半
  if (results.length < topK / 2) {
    return {
      isHighQuality: false,
      message: `Only found ${results.length} results (requested ${topK}). Try using different search terms or disabling filters.`,
      filteredCount
    }
  }

  // 如果大部分结果被过滤
  if (filteredCount > results.length / 2) {
    return {
      isHighQuality: false,
      message: `${filteredCount} low-quality results filtered out. Try refining your query.`,
      filteredCount
    }
  }

  return {
    isHighQuality: true,
    filteredCount
  }
}

/**
 * 计算检索召回数量（考虑重排序）
 *
 * @param topK 最终需要的数量
 * @param enableRerank 是否启用重排序
 * @returns 召回数量
 */
export function calculateRecallTopK(topK: number, enableRerank: boolean = true): number {
  return enableRerank ? topK * RECALL_MULTIPLIER : topK
}
