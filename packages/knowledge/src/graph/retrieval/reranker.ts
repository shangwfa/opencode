import { generateObject } from 'ai'
import { getDefaultChatModel } from '../../config/env.js'
import { z } from 'zod'
import { resolveModel } from '../../utils/model-resolver.js'
import type { Triplet } from '../types.js'

export type RerankMode = 'embedding' | 'llm'

export interface RerankConfig {
  mode?: RerankMode
  /** embedding 模式必需：文本批量嵌入函数 */
  embedTexts?: (texts: string[]) => Promise<number[][]>
  /** RRF 融合权重（rerank 排序占比，0-1），默认 0.5 */
  weight?: number
  /** llm 模式的模型名 */
  model?: string
  /** 原始查询文本（llm 模式必需） */
  queryText?: string
  /** llm 模式最大候选数，超过则截断，默认 30 */
  maxLLMCandidates?: number
}

export interface RerankResult {
  triplets: Triplet[]
  applied: boolean
  mode: RerankMode
  weight: number
  scoredCount: number
  error?: string
}

/** RRF 常数（标准值 60，抑制排名靠后项的贡献波动） */
const RRF_K = 60

/**
 * 三元组渲染文本。对英文名实体附带简短中文描述：API 字段/英文键名（如 scheduleType、Ctrl）
 * 与中文查询无词面信号，附加其简短纯中文描述（如"任务类型"）弥补 embedding 鸿沟。
 * 约束：纯英文名（≤20 字符）+ 纯中文简短描述（≤14 字），排除含 schema 前缀的长描述，
 * 避免污染 rerank 语义。
 */
export function tripletToText(t: Triplet): string {
  const render = (node: Triplet['source']) => {
    const name = node.name
    const isAsciiName = /^[a-zA-Z][a-zA-Z0-9_]{0,19}$/.test(name)
    const desc = String(node.properties?.description || '').replace(/\s+/g, '').trim()
    const isBriefCn = desc.length > 0 && desc.length <= 14 && /^[\u4e00-\u9fff]+$/.test(desc)
    return isAsciiName && isBriefCn ? `${name}（${node.type}：${desc}）` : `${name}（${node.type}）`
  }
  return `${render(t.source)}--${t.relation}--> ${render(t.target)}`
}

const RerankScoresSchema = z.object({
  scores: z.array(
    z.object({
      index: z.number().int().min(0),
      relevance: z.number().min(0).max(10),
    })
  ),
})

/**
 * 三元组重排序器（对标 TrustGraph graph_rag 的 cross-encoder rerank）
 *
 * 排序融合采用 Reciprocal Rank Fusion：
 *   finalScore_i = (1 - w) / (K + origRank_i + 1) + w / (K + rerankRank_i + 1)
 * 对原重要性分数与 rerank 分数的量纲差异鲁棒。
 *
 * 两种模式：
 * - embedding（默认）：三元组渲染文本 → 嵌入 → 与查询向量余弦相似度排序（bi-encoder 精排）
 * - llm：批量让 LLM 对（查询，三元组）打 0-10 相关性分（cross-encoder 式精排，更准但更贵）
 *
 * 任何失败均降级为原排序（applied=false），不中断检索主流程。
 */
export class TripletReranker {
  private config: RerankConfig

  constructor(config?: RerankConfig) {
    this.config = config || {}
  }

  async rerank(
    queryEmbedding: number[],
    triplets: Triplet[],
    queryText?: string,
    /** 多参考向量（对标 TrustGraph 与各 query concept 对齐打分）：取与任一参考的最大余弦 */
    referenceEmbeddings?: number[][]
  ): Promise<RerankResult> {
    const mode: RerankMode = this.config.mode || 'embedding'
    const weight = clamp(this.config.weight ?? 0.5, 0, 1)

    if (triplets.length <= 1) {
      return { triplets, applied: false, mode, weight, scoredCount: triplets.length }
    }

    try {
      if (mode === 'llm') {
        const qText = queryText || this.config.queryText
        if (!qText) {
          return { triplets, applied: false, mode, weight, scoredCount: 0, error: 'llm 模式需要 queryText' }
        }
        return await this.rerankWithLLM(qText, triplets, weight)
      }
      return await this.rerankWithEmbedding(queryEmbedding, triplets, weight, referenceEmbeddings)
    } catch (err: any) {
      console.warn(`[三元组重排] ${mode} rerank 失败（保留原排序）: ${err.message}`)
      return { triplets, applied: false, mode, weight, scoredCount: 0, error: err.message }
    }
  }

  private async rerankWithEmbedding(
    queryEmbedding: number[],
    triplets: Triplet[],
    weight: number,
    referenceEmbeddings?: number[][]
  ): Promise<RerankResult> {
    const embedTexts = this.config.embedTexts
    if (!embedTexts) {
      return { triplets, applied: false, mode: 'embedding', weight, scoredCount: 0, error: '未提供 embedTexts' }
    }

    const references = referenceEmbeddings && referenceEmbeddings.length > 0
      ? referenceEmbeddings
      : [queryEmbedding]

    const texts = triplets.map(tripletToText)
    const vectors = await batchEmbed(embedTexts, texts)
    // 与各参考向量（查询 + 概念/子查询）对齐：取最大余弦（对标 TrustGraph query concepts 打分）
    const scores = vectors.map((v) =>
      v ? Math.max(...references.map((ref) => cosineSimilarity(ref, v))) : 0
    )

    return { ...fuseByRRF(triplets, scores, weight), mode: 'embedding' as const }
  }

  private async rerankWithLLM(
    queryText: string,
    triplets: Triplet[],
    weight: number
  ): Promise<RerankResult> {
    const maxCandidates = this.config.maxLLMCandidates ?? 30
    const candidates = triplets.slice(0, maxCandidates)
    const model = resolveModel(this.config.model || getDefaultChatModel())

    const lines = candidates.map((t, i) => `${i}. ${tripletToText(t)}`).join('\n')
    const { object } = await generateObject({
      model,
      schema: RerankScoresSchema,
      prompt: `给定用户查询和候选三元组列表，为每条三元组评估其与查询的相关性并打分（0-10 整数，10 表示直接回答查询所需，0 表示完全无关）。

查询：${queryText}

候选三元组：
${lines}

只输出每条的 index 和 relevance 分数。`,
      temperature: 0,
    })

    const scores = new Array<number>(candidates.length).fill(0)
    for (const s of object.scores) {
      if (s.index >= 0 && s.index < candidates.length) {
        scores[s.index] = s.relevance / 10
      }
    }

    return { ...fuseByRRF(candidates, scores, weight), mode: 'llm' as const }
  }
}

/** RRF 融合：原始排序 × rerank 分数排序；score 写回 rerank 置信度（非 RRF 排名分） */
function fuseByRRF(
  triplets: Triplet[],
  rerankScores: number[],
  weight: number
): { triplets: Triplet[]; applied: true; weight: number; scoredCount: number } {
  const rerankOrder = rerankScores
    .map((score, index) => ({ score, index }))
    .sort((a, b) => b.score - a.score)
  const rerankRank = new Array<number>(rerankScores.length)
  rerankOrder.forEach((entry, rank) => {
    rerankRank[entry.index] = rank
  })

  const fused = triplets.map((triplet, origRank) => ({
    triplet,
    score: (1 - weight) / (RRF_K + origRank + 1) + weight / (RRF_K + rerankRank[origRank] + 1),
  }))

  fused.sort((a, b) => b.score - a.score)

  return {
    triplets: fused.map((f) => {
      // 融合分缩放到 (0, 1] 写回 score 供下游展示，weight 字段保持不变
      return { ...f.triplet, score: f.score * (RRF_K + 1) }
    }),
    applied: true,
    weight,
    scoredCount: triplets.length,
  }
}

async function batchEmbed(
  embedTexts: (texts: string[]) => Promise<number[][]>,
  texts: string[],
  batchSize = 64
): Promise<number[][]> {
  const out: number[][] = []
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize)
    const vectors = await embedTexts(batch)
    if (!vectors || vectors.length !== batch.length) {
      throw new Error(`embedTexts 返回数量不匹配（期望 ${batch.length}，实际 ${vectors?.length ?? 0}）`)
    }
    out.push(...vectors)
  }
  return out
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0
  let normA = 0
  let normB = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1)
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}
