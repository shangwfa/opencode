import { VectorService } from './vector.service'
import { KeywordSearchService } from './keyword-search.service'
import { QueryEnhancementService, getQueryEnhancementService } from './query-enhancement.service'
import { embed } from 'ai'
import { openaiChat, openaiEmbedding } from '../../../providers/llm.js'
import type { SearchResultItem } from '../types/knowledge-base.types'
import {
  MIN_RECALL_SCORE,
  DEFAULT_COARSE_TOP_K,
  DEFAULT_FINE_TOP_K,
  MAX_KEYWORDS_TO_EXTRACT,
  MIN_KEYWORD_LENGTH,
  MIN_RESULTS_FOR_KEYWORD_EXTRACTION,
  MAX_EXPANDED_QUERY_LENGTH,
  SEARCH_ERROR_MESSAGES,
  DEFAULT_ENABLE_QUERY_EXPANSION
} from '../../../config/search.constants'

export interface RecallOptions {
  enableMultiStage?: boolean // 是否启用多阶段召回
  enableQueryExpansion?: boolean // 是否启用查询扩展
  enableLLMEnhancement?: boolean // 是否启用 LLM 增强（查询扩展和关键词提取）
  coarseTopK?: number // 粗召回数量
  fineTopK?: number // 细召回数量
  pgVectorConfig?: { minScore?: number; ef?: number; probes?: number } // pgVector 特定配置
  embeddingModel?: string // 嵌入模型名称
  llmModel?: string // LLM 模型名称（用于查询增强）
  filter?: Record<string, any> // 元数据过滤条件（MongoDB 风格，透传至向量检索）
}

/**
 * 根据嵌入模型名称创建嵌入模型实例
 */
function createEmbeddingModel(embeddingModel: string): any {
  if (embeddingModel.startsWith('openai/')) {
    const modelName = embeddingModel.replace('openai/', '')
    return openaiEmbedding(modelName)
  } else {
    return openaiEmbedding(embeddingModel)
  }
}

export class RecallService {
  private vectorService: VectorService
  private keywordSearchService: KeywordSearchService
  private queryEnhancementService: QueryEnhancementService

  constructor(
    vectorService: VectorService,
    keywordSearchService: KeywordSearchService,
    queryEnhancementService?: QueryEnhancementService
  ) {
    this.vectorService = vectorService
    this.keywordSearchService = keywordSearchService
    this.queryEnhancementService = queryEnhancementService || getQueryEnhancementService()
  }

  /**
   * 召回：多阶段召回 + 查询扩展
   *
   * 优化点：
   * 1. 支持 LLM 增强的查询扩展
   * 2. 支持 LLM 增强的关键词提取
   * 3. 改进的分数阈值过滤
   */
  async recall(
    knowledgeBaseId: string,
    query: string,
    options: RecallOptions = {}
  ): Promise<SearchResultItem[]> {
    const {
      enableMultiStage = true,
      enableQueryExpansion = DEFAULT_ENABLE_QUERY_EXPANSION,
      enableLLMEnhancement = false,
      coarseTopK = DEFAULT_COARSE_TOP_K,
      fineTopK = DEFAULT_FINE_TOP_K,
      pgVectorConfig,
      embeddingModel,
      llmModel,
      filter
    } = options

    // 启用或禁用 LLM 增强
    if (enableLLMEnhancement) {
      this.queryEnhancementService.setEnabled(true)
    }

    // 查询扩展
    let expandedQuery = query
    if (enableQueryExpansion) {
      if (enableLLMEnhancement && this.queryEnhancementService.isEnabled()) {
        // 使用 LLM 进行查询扩展
        expandedQuery = await this.queryEnhancementService.expandQuery(query)
      } else {
        // 使用传统的查询扩展方法
        expandedQuery = await this.expandQuery(query)
      }
    }

    if (enableMultiStage) {
      // 多阶段召回
      return await this.multiStageRecall(
        knowledgeBaseId,
        expandedQuery,
        query, // 保存原始查询用于关键词提取
        coarseTopK,
        fineTopK,
        pgVectorConfig,
        embeddingModel,
        enableLLMEnhancement,
        filter
      )
    } else {
      // 单阶段召回
      return await this.singleStageRecall(knowledgeBaseId, expandedQuery, fineTopK, pgVectorConfig, embeddingModel, filter)
    }
  }

  /**
   * 多阶段召回：粗召回 + 细召回
   *
   * 优化点：
   * 1. 添加分数阈值过滤，避免低质量结果
   * 2. 改进关键词提取，避免噪声污染
   * 3. 支持 LLM 增强的关键词提取
   * 4. 限制扩展查询长度
   * 5. 验证关键词相关性
   */
  private async multiStageRecall(
    knowledgeBaseId: string,
    query: string,
    originalQuery: string, // 原始查询，用于关键词提取
    coarseTopK: number,
    fineTopK: number,
    pgVectorConfig?: { minScore?: number; ef?: number; probes?: number },
    embeddingModelName?: string,
    enableLLMEnhancement: boolean = false,
    filter?: Record<string, any>
  ): Promise<SearchResultItem[]> {
    // 第一阶段：粗召回（使用更大的 topK）
    const coarseResults = await this.singleStageRecall(
      knowledgeBaseId,
      query,
      coarseTopK,
      pgVectorConfig,
      embeddingModelName,
      filter
    )

    // 过滤低质量结果
    const minScore = pgVectorConfig?.minScore ?? MIN_RECALL_SCORE
    const qualityCoarseResults = coarseResults.filter(r => r.score >= minScore)

    if (qualityCoarseResults.length === 0) {
      // 如果粗召回性能太差，直接返回过滤后的结果（可能为空）
      return coarseResults.slice(0, fineTopK)
    }

    // 关键词提取需要足够样本，但细召回本身不应因粗召回数量少而跳过。
    let keywords: string[] = []

    if (qualityCoarseResults.length >= MIN_RESULTS_FOR_KEYWORD_EXTRACTION && enableLLMEnhancement && this.queryEnhancementService.isEnabled()) {
      // 使用 LLM 提取关键词
      keywords = await this.queryEnhancementService.extractKeywords(qualityCoarseResults, originalQuery)
    }

    // 如果 LLM 未提取到关键词或未启用，使用传统方法
    if (qualityCoarseResults.length >= MIN_RESULTS_FOR_KEYWORD_EXTRACTION && keywords.length === 0) {
      keywords = this.extractKeywords(qualityCoarseResults, originalQuery)
    }

    // 构建扩展查询，限制长度
    let expandedQuery = query
    const potentialQuery = `${query} ${keywords.join(' ')}`
    if (potentialQuery.length <= MAX_EXPANDED_QUERY_LENGTH) {
      expandedQuery = potentialQuery
    } else {
      // 如果扩展查询过长，截断部分关键词
      let tempQuery = query
      for (const keyword of keywords) {
        if ((tempQuery + ' ' + keyword).length <= MAX_EXPANDED_QUERY_LENGTH) {
          tempQuery += ' ' + keyword
        } else {
          break
        }
      }
      expandedQuery = tempQuery
    }

    // 使用扩展查询进行细召回
    const fineResults = await this.singleStageRecall(
      knowledgeBaseId,
      expandedQuery,
      fineTopK,
      pgVectorConfig,
      embeddingModelName,
      filter
    )

    // 合并结果，去重，保留更高分数
    const resultMap = new Map<string, SearchResultItem>()
    for (const result of [...qualityCoarseResults, ...fineResults]) {
      const existing = resultMap.get(result.id)
      if (!existing || result.score > existing.score) {
        resultMap.set(result.id, result)
      }
    }

    // 按分数排序并返回 topK
    const sortedResults = Array.from(resultMap.values())
      .sort((a, b) => b.score - a.score)

    return sortedResults.slice(0, fineTopK)
  }

  /**
   * 单阶段召回
   */
  private async singleStageRecall(
    knowledgeBaseId: string,
    query: string,
    topK: number,
    pgVectorConfig?: { minScore?: number; ef?: number; probes?: number },
    embeddingModelName?: string,
    filter?: Record<string, any>
  ): Promise<SearchResultItem[]> {
    // 生成查询向量
    const modelName = embeddingModelName || 'openai/text-embedding-3-small'
    const embeddingModel = createEmbeddingModel(modelName)
    const { embedding } = await embed({
      value: query,
      model: embeddingModel
    })

    // 查询向量数据库
    const results = await this.vectorService.query(knowledgeBaseId, embedding, topK, filter, pgVectorConfig)

    // 格式化结果，确保 metadata.text 存在
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
   * 查询扩展：同义词扩展、查询重写
   */
  private async expandQuery(query: string): Promise<string> {
    // 简单的查询扩展实现
    // 1. 提取关键词
    const keywords = query.split(/\s+/).filter((word) => word.length > 2)

    // 2. 简单的同义词扩展（可以后续接入同义词库或 LLM）
    const synonyms: Record<string, string[]> = {
      // 示例同义词
      '问题': ['疑问', '难题'],
      '解决': ['处理', '修复'],
      '方法': ['方式', '途径']
    }

    const expandedKeywords: string[] = []
    for (const keyword of keywords) {
      expandedKeywords.push(keyword)
      if (synonyms[keyword]) {
        expandedKeywords.push(...synonyms[keyword])
      }
    }

    // 3. 组合扩展后的查询
    return expandedKeywords.join(' ')
  }

  /**
   * 从结果中提取关键词（改进版）
   *
   * 优化点：
   * 1. 提高词频阈值，避免低频噪声
   * 2. 优先提取分数高的结果中的关键词
   * 3. 过滤掉与原查询重复的词
   * 4. 优先保留名词性词汇
   */
  private extractKeywords(results: SearchResultItem[], originalQuery: string): string[] {
    // 扩展停用词表
    const stopWords = new Set([
      // 中文停用词
      '的', '了', '在', '是', '和', '有', '与', '或', '及', '等', '就', '都', '而', '及', '以', '之',
      // 英文停用词
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by',
      // 数字和符号
      '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'
    ])

    // 词频统计（考虑结果分数权重）
    const wordFreq = new Map<string, number>()
    const originalQueryLower = originalQuery.toLowerCase()

    for (const result of results) {
      // 按空格和标点符号分词
      const words = result.text
        .toLowerCase()
        .replace(/[，。！？；：、""''（）【】《》,.!?;:""'\[\]<>]/g, ' ')
        .split(/\s+/)
        .filter((word) => {
          // 过滤条件
          if (word.length < MIN_KEYWORD_LENGTH) return false
          if (stopWords.has(word)) return false
          if (originalQueryLower.includes(word)) return false
          // 过滤纯数字
          if (/^\d+$/.test(word)) return false
          return true
        })

      // 根据结果分数加权统计词频
      const weight = Math.max(0.5, result.score) // 最低权重 0.5
      for (const word of words) {
        wordFreq.set(word, (wordFreq.get(word) || 0) + weight)
      }
    }

    // 计算平均出现次数，作为阈值
    const avgFreq = Array.from(wordFreq.values()).reduce((sum, freq) => sum + freq, 0) / Math.max(1, wordFreq.size)

    // 提取高频关键词，频率必须高于平均值
    const keywords = Array.from(wordFreq.entries())
      .filter(([_, freq]) => freq >= avgFreq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_KEYWORDS_TO_EXTRACT)
      .map(([word]) => word)

    return keywords
  }
}
