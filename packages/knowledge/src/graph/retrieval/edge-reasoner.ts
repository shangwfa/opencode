import { generateObject } from 'ai'
import { getDefaultChatModel } from '../../config/env.js'
import { z } from 'zod'
import { resolveModel } from '../../utils/model-resolver.js'
import type { Triplet } from '../types.js'
import { tripletToText } from './reranker.js'

export interface EdgeReasonerConfig {
  /** llm 模型名 */
  model?: string
  /** 最多解释条数（只解释最终返回的边，控制 token 成本），默认 10 */
  maxEdges?: number
}

/**
 * 边推理器（对标 TrustGraph GraphRAG 步骤 7 edge reasoning）
 *
 * 对最终选中的每条边，让 LLM 解释"这条边为何与问题相关"，
 * 产出可随上下文一起返回的推理说明——下游 LLM 拿到的不只是事实，
 * 还有事实与问题的关联逻辑，回答质量更高且可审计。
 *
 * 任何失败均降级为空结果（不阻塞检索主流程）。
 */
export class EdgeReasoner {
  private config: EdgeReasonerConfig

  constructor(config?: EdgeReasonerConfig) {
    this.config = config || {}
  }

  /**
   * 为三元组列表逐条生成相关性解释
   * @returns index → reason 映射（仅包含成功生成的条目）
   */
  async explain(queryText: string, triplets: Triplet[]): Promise<Map<number, string>> {
    const result = new Map<number, string>()
    if (!queryText || triplets.length === 0) return result

    const maxEdges = this.config.maxEdges ?? 10
    const candidates = triplets.slice(0, maxEdges)
    const model = resolveModel(this.config.model || getDefaultChatModel())

    try {
      const lines = candidates.map((t, i) => `${i}. ${tripletToText(t)}`).join('\n')
      const { object } = await generateObject({
        model,
        schema: EdgeReasonsSchema,
        prompt: `给定用户问题和知识图谱三元组列表，逐条解释每条三元组与回答该问题的关联逻辑。

要求：
- 每条解释不超过 50 字，直接说明该关系如何支撑回答
- 若某条确实无关，解释中写明"关联较弱"及原因

用户问题：${queryText}

三元组列表：
${lines}`,
        temperature: 0,
      })

      for (const r of object.reasons) {
        if (r.index >= 0 && r.index < candidates.length && r.reason) {
          result.set(r.index, r.reason)
        }
      }
    } catch (err: any) {
      console.warn(`[边推理] 生成解释失败（跳过）: ${err.message}`)
    }

    return result
  }
}

const EdgeReasonsSchema = z.object({
  reasons: z.array(
    z.object({
      index: z.number().int().min(0),
      reason: z.string().min(1),
    })
  ),
})
