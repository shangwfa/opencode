import { generateText } from 'ai'
import { openaiChat, openaiEmbedding } from '../../../providers/llm.js'
import { embed } from 'ai'
import type { SearchResultItem } from '../types/knowledge-base.types'
import { VectorService } from './vector.service'

/**
 * HyDE (Hypothetical Document Embeddings) 服务
 *
 * 核心思想：使用 LLM 生成假设性答案，然后用假设答案的向量进行检索
 *
 * 优势：
 * 1. 填补查询-文档语义鸿沟
 * 2. 提升召回率 15-20%
 * 3. 对模糊查询特别有效
 */
export class HyDEService {
  private llmModel: string
  private embeddingModel: string
  private enabled: boolean

  constructor(
    llmModel: string = 'gpt-4o-mini',
    embeddingModel: string = 'openai/text-embedding-3-small',
    enabled: boolean = true
  ) {
    this.llmModel = llmModel
    this.embeddingModel = embeddingModel
    this.enabled = enabled
  }

  /**
   * 生成假设性文档
   *
   * @param query 用户查询
   * @returns 假设性文档内容
   */
  async generateHypotheticalDocument(query: string): Promise<string> {
    if (!this.enabled) {
      return query
    }

    try {
      const prompt = this.buildHyDEPrompt(query)

      const { text } = await generateText({
        model: openaiChat(this.llmModel),
        prompt,
        temperature: 0.3, // 较低温度保证稳定性
        maxOutputTokens: 500, // 假设答案 150-200 词
      })

      return text.trim()
    } catch (error: any) {
      console.error('HyDE generation failed:', error.message)
      // 失败时返回原查询
      return query
    }
  }

  /**
   * 使用 HyDE 进行向量检索
   *
   * @param knowledgeBaseId 知识库ID
   * @param query 用户查询
   * @param topK 召回数量
   * @param vectorService 向量服务
   * @param pgVectorConfig pgVector 配置
   * @returns 检索结果
   */
  async searchWithHyDE(
    knowledgeBaseId: string,
    query: string,
    topK: number,
    vectorService: VectorService,
    pgVectorConfig?: { minScore?: number; ef?: number; probes?: number }
  ): Promise<SearchResultItem[]> {
    if (!this.enabled) {
      // 如果未启用，直接使用原查询检索
      return this.standardSearch(knowledgeBaseId, query, topK, vectorService, pgVectorConfig)
    }

    try {
      // 步骤1: 生成假设性文档
      const hypotheticalDoc = await this.generateHypotheticalDocument(query)

      // 步骤2: 对假设性文档进行向量检索
      return this.standardSearch(knowledgeBaseId, hypotheticalDoc, topK, vectorService, pgVectorConfig)
    } catch (error: any) {
      console.error('HyDE search failed, falling back to standard search:', error.message)
      // 失败时回退到标准检索
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
   * 构建 HyDE Prompt
   */
  private buildHyDEPrompt(query: string): string {
    return `You are a knowledgeable assistant. Given the following query, generate a comprehensive and detailed answer passage.

Query: "${query}"

Requirements:
1. Provide a detailed answer (150-200 words)
2. Cover multiple aspects of the topic
3. Include relevant terminology and concepts
4. Be specific and factual
5. Write in a clear, explanatory style

Answer passage:`
  }

  /**
   * 启用或禁用 HyDE
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
}

/**
 * 默认实例
 */
let defaultInstance: HyDEService | null = null

/**
 * 获取默认的 HyDE 服务实例
 */
export function getHyDEService(
  llmModel?: string,
  embeddingModel?: string,
  enabled?: boolean
): HyDEService {
  if (!defaultInstance) {
    defaultInstance = new HyDEService(llmModel, embeddingModel, enabled)
  }
  return defaultInstance
}
