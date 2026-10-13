import { generateText } from 'ai'
import { openaiChat, openaiEmbedding } from '../../../providers/llm.js'
import { embed } from 'ai'
import type { SearchResultItem } from '../types/knowledge-base.types'
import { VectorService } from './vector.service'
import { reciprocalRankFusion } from '../../../utils/rrf-fusion'

/**
 * 多查询检索服务
 *
 * 核心思想：LLM 生成多个查询变体，并行检索，使用 RRF 融合结果
 *
 * 优势：
 * 1. 扩大检索覆盖面
 * 2. 解决同义词和多表达问题
 * 3. 提升召回率 20-30%
 */
export class MultiQueryService {
  private llmModel: string
  private embeddingModel: string
  private enabled: boolean
  private defaultNumVariations: number

  constructor(
    llmModel: string = 'gpt-4o-mini',
    embeddingModel: string = 'openai/text-embedding-3-small',
    enabled: boolean = true,
    defaultNumVariations: number = 3
  ) {
    this.llmModel = llmModel
    this.embeddingModel = embeddingModel
    this.enabled = enabled
    this.defaultNumVariations = defaultNumVariations
  }

  /**
   * 生成查询变体
   *
   * @param query 原始查询
   * @param numVariations 生成数量，默认 3
   * @returns 查询变体列表
   */
  async generateQueryVariations(
    query: string,
    numVariations: number = this.defaultNumVariations
  ): Promise<string[]> {
    if (!this.enabled) {
      return []
    }

    try {
      const prompt = this.buildQueryVariationsPrompt(query, numVariations)

      const { text } = await generateText({
        model: openaiChat(this.llmModel),
        prompt,
        temperature: 0.4, // 中等温度，保证多样性
        maxOutputTokens: 300,
      })

      // 解析生成的变体
      const variations = this.parseQueryVariations(text, numVariations)

      // 过滤掉与原查询重复的
      const uniqueVariations = variations.filter(v => v.toLowerCase() !== query.toLowerCase())

      return uniqueVariations.slice(0, numVariations)
    } catch (error: any) {
      console.error('Query variation generation failed:', error.message)
      return []
    }
  }

  /**
   * 使用多查询进行检索
   *
   * @param knowledgeBaseId 知识库ID
   * @param query 原始查询
   * @param topK 召回数量
   * @param vectorService 向量服务
   * @param pgVectorConfig pgVector 配置
   * @param numVariations 变体数量
   * @returns 检索结果
   */
  async searchWithMultiQuery(
    knowledgeBaseId: string,
    query: string,
    topK: number,
    vectorService: VectorService,
    pgVectorConfig?: { minScore?: number; ef?: number; probes?: number },
    numVariations: number = this.defaultNumVariations
  ): Promise<SearchResultItem[]> {
    if (!this.enabled) {
      // 如果未启用，直接使用原查询检索
      return this.standardSearch(knowledgeBaseId, query, topK, vectorService, pgVectorConfig)
    }

    try {
      // 步骤1: 生成查询变体
      const variations = await this.generateQueryVariations(query, numVariations)

      if (variations.length === 0) {
        // 如果没有生成变体，使用标准检索
        console.warn('No query variations generated, falling back to standard search')
        return this.standardSearch(knowledgeBaseId, query, topK, vectorService, pgVectorConfig)
      }

      // 步骤2: 并行检索所有查询（包括原始查询）
      const allQueries = [query, ...variations]

      console.log(`Multi-query: 检索 ${allQueries.length} 个查询`)

      const allResults = await Promise.all(
        allQueries.map(async (q) => {
          return await this.standardSearch(knowledgeBaseId, q, topK, vectorService, pgVectorConfig)
        })
      )

      console.log(`Multi-query: 总共召回 ${allResults.flat().length} 个结果`)

      // 步骤3: 使用 RRF 融合
      const mergedResults = reciprocalRankFusion(allResults, 60)

      console.log(`Multi-query: 融合后 ${mergedResults.length} 个结果`)

      return mergedResults.slice(0, topK)
    } catch (error: any) {
      console.error('Multi-query search failed, falling back to standard search:', error.message)
      return this.standardSearch(knowledgeBaseId, query, topK, vectorService, pgVectorConfig)
    }
  }

  /**
   * 标准向量检索
   */
  private async standardSearch(
    knowledgeBaseId: string,
    query: string,
    topK: number,
    vectorService: VectorService,
    pgVectorConfig?: { minScore?: number; ef?: number; probes?: number }
  ): Promise<SearchResultItem[]> {
    // 生成查询向量
    const { embedding } = await embed({
      value: query,
      model: this.embeddingModel.startsWith('openai/')
        ? openaiEmbedding(this.embeddingModel.replace('openai/', ''))
        : openaiEmbedding(this.embeddingModel)
    })

    // 向量检索
    const results = await vectorService.query(
      knowledgeBaseId,
      embedding,
      topK,
      undefined,
      pgVectorConfig
    )

    // 格式化结果
    return results.map((result) => {
      const text = result.metadata?.text || ''
      return {
        id: result.id,
        text,
        score: result.score || 0,
        metadata: {
          ...result.metadata,
          text
        },
        documentId: result.metadata?.documentId || '',
        chunkIndex: result.metadata?.chunkIndex
      }
    })
  }

  /**
   * 构建查询变体生成 Prompt
   */
  private buildQueryVariationsPrompt(query: string, numVariations: number): string {
    return `You are a search query optimization expert. Given the following query, generate ${numVariations} different query variations that will help find more relevant documents.

Original query: "${query}"

Requirements:
1. Each variation should express the same meaning using different words
2. Cover different aspects or perspectives of the topic
3. Include domain-specific terminology where appropriate
4. Keep queries concise and clear (5-15 words each)
5. Avoid duplicating the original query wording

Generate exactly ${numVariations} query variations, one per line:
`
  }

  /**
   * 解析生成的查询变体
   */
  private parseQueryVariations(text: string, numVariations: number): string[] {
    // 按行分割
    const lines = text
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)

    // 提取查询（支持多种格式）
    const variations: string[] = []

    for (const line of lines) {
      // 移除可能的编号前缀（如 "1. ", "- ", "* "）
      const cleaned = line
        .replace(/^\d+[\.\)]\s*/, '') // 移除 "1. ", "1) "
        .replace(/^[-*]\s*/, '') // 移除 "- ", "* "
        .trim()

      if (cleaned.length > 3 && cleaned.length < 100) {
        variations.push(cleaned)
      }
    }

    return variations.slice(0, numVariations)
  }

  /**
   * 启用或禁用多查询检索
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
  }

  /**
   * 检查是否启用
   */
  isEnabled(): boolean {
    return this.enabled
  }

  /**
   * 设置 LLM 模型
   */
  setLLMModel(model: string): void {
    this.llmModel = model
  }

  /**
   * 设置嵌入模型
   */
  setEmbeddingModel(model: string): void {
    this.embeddingModel = model
  }

  /**
   * 设置默认变体数量
   */
  setDefaultNumVariations(num: number): void {
    if (num < 1 || num > 10) {
      console.warn(`Invalid numVariations: ${num}, must be between 1 and 10`)
      return
    }
    this.defaultNumVariations = num
  }
}

/**
 * 默认实例
 */
let defaultInstance: MultiQueryService | null = null

/**
 * 获取默认的多查询服务实例
 */
export function getMultiQueryService(
  llmModel?: string,
  embeddingModel?: string,
  enabled?: boolean,
  numVariations?: number
): MultiQueryService {
  if (!defaultInstance) {
    defaultInstance = new MultiQueryService(llmModel, embeddingModel, enabled, numVariations)
  }
  return defaultInstance
}
