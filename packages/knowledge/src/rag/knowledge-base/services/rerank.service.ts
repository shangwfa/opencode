import type { SearchResultItem } from '../types/knowledge-base.types'
import { generateText } from 'ai'
import { openaiChat, openaiEmbedding } from '../../../providers/llm.js'
import { calculateTimeDecayBonus } from '../../../utils/time-decay.js'
import { getActiveTimeDecayConfig } from '../../../config/time-decay.config.js'

export interface RerankOptions {
  model?: 'llm' | 'mastra' | 'cohere' | 'zeroentropy' | 'simple'
  topK?: number
}

/**
 * LLM 相关性打分器（替代 @mastra/rag 的 MastraAgentRelevanceScorer，不再依赖 mastra agent）。
 * 使用 'ai' 的 generateText + openaiChat，对 (query, chunk) 让 LLM 输出 0-1 相关性分数。
 * 调用失败或解析失败时抛错，由上层回退到 simpleRerank。
 */
export class LLMRelevanceScorer {
  private name: string
  private model: any

  constructor(name: string, model: any) {
    this.name = name
    this.model = model
  }

  /** 对单个文档块打分，返回 0-1 的相关性分数 */
  async score(query: string, text: string): Promise<number> {
    const prompt = `你是一个搜索结果相关性打分器。请判断下面的文档块与用户查询的相关程度。

评分标准：
- 1.0：文档块直接回答或高度契合查询
- 0.5：文档块与查询部分相关
- 0.0：文档块与查询完全无关

只输出一个 0 到 1 之间的纯数字（可带小数），不要输出任何其他文字、解释或引号。

用户查询：
${query}

文档块：
${text}

相关性分数（0-1 的纯数字）：`

    const { text: output } = await generateText({
      model: this.model,
      prompt
    })

    // 解析纯数字输出
    const match = String(output ?? '').match(/-?\d+(\.\d+)?/)
    if (!match) {
      throw new Error(`[${this.name}] 无法解析 LLM 打分输出: ${String(output).slice(0, 100)}`)
    }
    const score = Number.parseFloat(match[0])
    if (Number.isNaN(score)) {
      throw new Error(`[${this.name}] LLM 打分输出不是有效数字: ${String(output).slice(0, 100)}`)
    }
    // 限制分数在 0-1 之间
    return Math.max(0, Math.min(1, score))
  }
}

export class RerankService {
  private relevanceScorer: LLMRelevanceScorer | null = null

  constructor() {
    // 初始化 LLMRelevanceScorer
    try {
      // Type cast to avoid type incompatibility between AI SDK and provider types
      const model = openaiChat('gpt-4o-mini') as any
      this.relevanceScorer = new LLMRelevanceScorer('relevance-scorer', model)
    } catch (error: any) {
      console.warn('Failed to initialize LLMRelevanceScorer:', error.message)
      this.relevanceScorer = null
    }
  }

  /**
   * 重排序搜索结果
   * 优先使用 Mastra 专业重排序服务，失败时回退到简化实现
   */
  async rerank(query: string, results: SearchResultItem[], options: RerankOptions = {}): Promise<SearchResultItem[]> {
    const { model = 'simple', topK = 20 } = options

    if (results.length === 0) {
      return []
    }

    // 如果明确指定使用简化重排序，直接使用（只重排，不改写分数）
    if (model === 'simple') {
      return this.simpleRerank(query, results, topK)
    }

    // LLM 相关性打分（model='llm'；'mastra' 为兼容旧枚举的同一路径）
    // 打分语义：1.0 直接回答 / 0.5 部分相关 / 0.0 无关 —— 具有绝对语义，可作为质量阈值裁判
    if ((model === 'llm' || model === 'mastra') && this.relevanceScorer) {
      try {
        // 确保结果格式符合要求：每个结果必须包含 metadata.text
        const formattedResults = results.map((result) => ({
          id: result.id,
          text: result.metadata?.text || result.text,
          score: result.score,
          metadata: {
            ...result.metadata,
            text: result.metadata?.text || result.text // 确保 metadata.text 存在
          }
        }))

        // 使用 LLM 相关性打分进行重排序（替代原 MastraAgentRelevanceScorer + rerankWithScorer）
        const scorer = this.relevanceScorer
        const scoredResults = await Promise.all(
          formattedResults.map(async (item) => ({
            ...item,
            score: await scorer.score(query, item.text)
          }))
        )
        const rerankedResults = scoredResults.sort((a, b) => b.score - a.score).slice(0, topK)

        // 调试：检查重排序返回的结果
        console.log(`[RerankService] 重排序返回 ${rerankedResults.length} 个结果`)
        if (rerankedResults.length > 0) {
          console.log(`[RerankService] 重排序后第一个结果:`, {
            id: rerankedResults[0]?.id,
            hasText: !!rerankedResults[0]?.text,
            hasMetadata: !!rerankedResults[0]?.metadata,
            metadataKeys: rerankedResults[0]?.metadata ? Object.keys(rerankedResults[0].metadata).slice(0, 10) : [],
            fullResult: JSON.stringify(rerankedResults[0], null, 2).substring(0, 500)
          })
        }

        // 转换回 SearchResultItem 格式
        // 需要从原始结果中恢复完整信息，因为 rerankWithScorer 可能只返回部分字段
        const originalResultsMap = new Map<string, SearchResultItem>()
        results.forEach((r) => {
          originalResultsMap.set(r.id, r)
        })

        return rerankedResults.map((item: any) => {
          // rerankWithScorer 返回的结果可能包装在 result 字段中
          const result = item.result || item

          // 从原始结果中获取完整信息
          const original = originalResultsMap.get(result.id)
          if (original) {
            // 保留原始结果的所有字段，只更新分数
            // 确保 text 字段优先使用原始结果的 text，如果为空则从 metadata.text 获取
            const text = original.text || original.metadata?.text || result.text || result.metadata?.text || ''
            return {
              ...original,
              text: text, // 确保 text 字段存在
              score: result.score || result.relevanceScore || original.score,
              // 确保 metadata.text 也存在（用于向后兼容）
              metadata: {
                ...original.metadata,
                text: text
              }
            }
          }
          // 如果找不到原始结果，使用返回的结果（向后兼容）
          // 确保 text 字段存在
          const text = result.metadata?.text || result.text || ''
          return {
            id: result.id,
            text: text,
            score: result.score || result.relevanceScore || 0,
            metadata: {
              ...result.metadata,
              text: text // 确保 metadata.text 也存在
            },
            documentId: result.metadata?.documentId || result.documentId || '',
            chunkIndex: result.metadata?.chunkIndex || result.chunkIndex
          }
        })
      } catch (error: any) {
        console.warn('Mastra reranking failed, falling back to simple reranking:', error.message)
        // 回退到简化实现
        return this.simpleRerank(query, results, topK)
      }
    }

    // 使用简化实现作为后备方案
    return this.simpleRerank(query, results, topK)
  }

  /**
   * 简化重排序实现（后备方案）
   * 优化：基于元信息（路径、文档名、新鲜度）进行增强重排序
   */
  private simpleRerank(query: string, results: SearchResultItem[], topK: number): SearchResultItem[] {
    try {
      // 提取查询关键词
      const queryKeywords = query
        .toLowerCase()
        .split(/\s+/)
        .filter((word) => word.length > 1)

      const queryLower = query.toLowerCase()

      // 计算每个结果的启发分（语义 + 词法 + 元信息，输入恒为绝对分故输出仍具绝对语义）
      const rerankedResults = results.map((result) => {
        const text = result.text.toLowerCase()
        const metadata = result.metadata || {}
        let newScore = result.score

        // 1. 计算关键词匹配度（原始逻辑）
        let keywordMatches = 0
        let earlyMatchBonus = 0

        for (const keyword of queryKeywords) {
          const index = text.indexOf(keyword)
          if (index !== -1) {
            keywordMatches++
            // 关键词出现在文本前 100 个字符内，给予额外加分
            if (index < 100) {
              earlyMatchBonus += 0.1
            }
          }
        }

        const keywordCoverage = queryKeywords.length > 0 ? keywordMatches / queryKeywords.length : 0

        // 2. 元信息加权（新增）
        let metadataBonus = 0

        // 2.1 路径匹配加分
        const docPath = (metadata.docPath || '').toLowerCase()
        if (docPath.includes(queryLower)) {
          metadataBonus += 0.15 // 路径包含查询词，加分15%
        }

        // 2.2 文档名匹配加分
        const docName = (metadata.docName || '').toLowerCase()
        if (docName.includes(queryLower)) {
          metadataBonus += 0.2 // 文档名包含查询词，加分20%
        }

        // 2.3 新鲜度加分（使用指数衰减）
        // 采用平滑的指数衰减策略，避免分段突变
        // 参考 Elasticsearch decay functions 实现
        // 策略配置：config/time-decay.config.ts
        const syncedAt = metadata.syncedAt
        if (syncedAt) {
          metadataBonus += calculateTimeDecayBonus(
            syncedAt,
            getActiveTimeDecayConfig() // 使用配置文件中的策略（当前：保守策略）
          )
        }

        // 2.4 路径层级优先级（层级越浅，权重越高）
        if (docPath) {
          const pathDepth = docPath.split('/').length
          if (pathDepth <= 2) {
            metadataBonus += 0.05 // 顶层或第二层文档：+5%
          } else if (pathDepth <= 4) {
            metadataBonus += 0.02 // 第三、四层文档：+2%
          }
        }

        // 综合评分：输入分数 × 语义成分 + 关键词覆盖 × 词法成分 + 元信息加成。
        // 前提：进入 rerank 的 score 已保证为绝对分（召回相似度 / 融合层恢复的绝对分），
        // 因此本公式输出仍具绝对语义，可安全用于质量阈值过滤。
        // 词法成分（coverage/earlyMatch）弥补短查询子串命中但 cosine 偏低的场景
        // （如查询为块文本子串时 token 零重叠 → cosine=0，词法命中是唯一质量信号）。
        newScore = result.score * 0.6 + keywordCoverage * 0.2 + metadataBonus + earlyMatchBonus

        return {
          ...result,
          score: Math.min(newScore, 1.0) // 限制分数在 0-1 之间
        }
      })

      // 按新分数排序并返回 topK
      return rerankedResults.sort((a, b) => b.score - a.score).slice(0, topK)
    } catch (error: any) {
      // 如果重排序失败，返回原始结果
      console.warn('Simple reranking failed:', error.message)
      return results.slice(0, topK)
    }
  }
}
