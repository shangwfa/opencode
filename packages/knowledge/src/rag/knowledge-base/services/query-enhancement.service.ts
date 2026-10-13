import { generateText } from 'ai'
import { openaiChat, openaiEmbedding } from '../../../providers/llm.js'
import type { SearchResultItem } from '../types/knowledge-base.types'
import {
  MAX_KEYWORDS_TO_EXTRACT,
  MAX_EXPANDED_QUERY_LENGTH,
  DEFAULT_ENABLE_QUERY_EXPANSION
} from '../../../config/search.constants'

/**
 * 查询增强服务
 *
 * 使用 LLM 进行智能查询扩展和关键词提取
 */
export class QueryEnhancementService {
  private llmModel: string
  private enabled: boolean

  constructor(llmModel: string = 'gpt-4o-mini', enabled: boolean = DEFAULT_ENABLE_QUERY_EXPANSION) {
    this.llmModel = llmModel
    this.enabled = enabled
  }

  /**
   * 使用 LLM 进行查询扩展
   *
   * @param query 原始查询
   * @param context 上下文信息（可选）
   * @returns 扩展后的查询
   */
  async expandQuery(query: string, context?: { results?: SearchResultItem[] }): Promise<string> {
    if (!this.enabled) {
      return query
    }

    try {
      const prompt = this.buildQueryExpansionPrompt(query, context)

      const { text } = await generateText({
        model: openaiChat(this.llmModel),
        prompt,
        temperature: 0.3, // 较低温度保证稳定性
        maxOutputTokens: 100
      })

      // 清理并验证结果
      const expandedQuery = text.trim()

      // 如果 LLM 返回空或无效结果，返回原查询
      if (!expandedQuery || expandedQuery.length < query.length) {
        console.warn('LLM query expansion returned invalid result, using original query')
        return query
      }

      // 限制长度
      if (expandedQuery.length > MAX_EXPANDED_QUERY_LENGTH) {
        console.warn(`LLM query expansion too long (${expandedQuery.length}), truncating`)
        return query
      }

      return expandedQuery
    } catch (error: any) {
      console.warn('LLM query expansion failed, falling back to original query:', error.message)
      return query
    }
  }

  /**
   * 使用 LLM 从搜索结果中提取高质量关键词
   *
   * @param results 搜索结果
   * @param originalQuery 原始查询
   * @returns 提取的关键词列表
   */
  async extractKeywords(results: SearchResultItem[], originalQuery: string): Promise<string[]> {
    if (!this.enabled || results.length === 0) {
      return []
    }

    try {
      // 只使用高分结果进行关键词提取
      const topResults = results
        .filter(r => r.score >= 0.3)
        .slice(0, 10)
        .map(r => r.text)
        .join('\n\n')

      if (!topResults) {
        return []
      }

      const prompt = this.buildKeywordExtractionPrompt(originalQuery, topResults)

      const { text } = await generateText({
        model: openaiChat(this.llmModel),
        prompt,
        temperature: 0.2,
        maxOutputTokens: 150
      })

      // 解析关键词
      const keywords = text
        .split(/[,，\n]/)
        .map(k => k.trim())
        .filter(k => k.length >= 2 && !originalQuery.toLowerCase().includes(k.toLowerCase()))
        .slice(0, MAX_KEYWORDS_TO_EXTRACT)

      return keywords
    } catch (error: any) {
      console.warn('LLM keyword extraction failed:', error.message)
      return []
    }
  }

  /**
   * 使用 LLM 优化查询（重写和扩展）
   *
   * @param query 原始查询
   * @returns 优化后的查询
   */
  async optimizeQuery(query: string): Promise<{ optimized: string; original: string }> {
    if (!this.enabled || query.length < 5) {
      return { optimized: query, original: query }
    }

    try {
      const prompt = `你是一个搜索查询优化专家。请优化以下搜索查询，使其更精确、更全面。

原始查询：${query}

要求：
1. 保持查询的核心意图
2. 添加相关的同义词或相关词（用空格分隔）
3. 简洁明了，不超过 ${MAX_EXPANDED_QUERY_LENGTH} 字符
4. 只返回优化后的查询，不要解释

优化后的查询：`

      const { text } = await generateText({
        model: openaiChat(this.llmModel),
        prompt,
        temperature: 0.3,
        maxOutputTokens: 80
      })

      const optimized = text.trim()

      if (!optimized || optimized.length < query.length || optimized.length > MAX_EXPANDED_QUERY_LENGTH) {
        return { optimized: query, original: query }
      }

      return { optimized, original: query }
    } catch (error: any) {
      console.warn('LLM query optimization failed:', error.message)
      return { optimized: query, original: query }
    }
  }

  /**
   * 构建查询扩展提示词
   */
  private buildQueryExpansionPrompt(query: string, context?: { results?: SearchResultItem[] }): string {
    let prompt = `你是一个专业的研究助手。请扩展以下搜索查询，使其能够找到更多相关结果。

原始查询：${query}

任务：添加相关的同义词、相关术语或表达方式，以提高召回率。

要求：
1. 保持原查询的核心意图
2. 添加 3-5 个相关的同义词或相关词
3. 用空格分隔所有词汇
4. 简洁明了，不超过 ${MAX_EXPANDED_QUERY_LENGTH} 字符
5. 只返回扩展后的查询，不要解释

扩展后的查询：`

    return prompt
  }

  /**
   * 构建关键词提取提示词
   */
  private buildKeywordExtractionPrompt(originalQuery: string, resultsText: string): string {
    return `你是一个专业的信息提取专家。请从以下搜索结果中提取 ${MAX_KEYWORDS_TO_EXTRACT} 个最重要的关键词，用于扩展搜索查询。

原始查询：${originalQuery}

搜索结果片段：
${resultsText}

任务：提取能够帮助找到更多相关结果的关键词。

要求：
1. 提取 ${MAX_KEYWORDS_TO_EXTRACT} 个最相关的关键词
2. 关键词应该是专业术语、重要概念或相关表达
3. 避免提取与原始查询重复的词
4. 避免提取常见的停用词（如"的"、"了"、"是"等）
5. 关键词之间用逗号分隔
6. 只返回关键词列表，不要解释

关键词列表：`
  }

  /**
   * 启用或禁用 LLM 增强
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
}

// 默认实例
let defaultInstance: QueryEnhancementService | null = null

/**
 * 获取默认的查询增强服务实例
 *
 * @param llmModel LLM 模型名称
 * @param enabled 是否启用
 * @returns 查询增强服务实例
 */
export function getQueryEnhancementService(
  llmModel?: string,
  enabled?: boolean
): QueryEnhancementService {
  if (!defaultInstance) {
    defaultInstance = new QueryEnhancementService(llmModel, enabled)
  }
  return defaultInstance
}
