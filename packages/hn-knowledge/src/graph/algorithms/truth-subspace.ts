import type { GraphDB } from '../interface.js'
import type { GraphNode } from '../types.js'
import { GraphCompletionRetriever, type GraphSearchOptions, type CompletionResult } from '../retrieval/graph-completion-retriever.js'

/**
 * 真值子空间检索器
 *
 * 对标 cognee 的「真值子空间」概念：每个用户对实体有个人偏好（personal influence 0-1），
 * 检索时查询向量向偏好实体嵌入方向偏移（子空间投影），三元组重要性按偏好加权，
 * 实现「用户 A 更喜欢咖啡，用户 B 更喜欢茶」的差异化检索。
 *
 * 用法：
 *   const subspace = new TruthSubspaceRetriever(adapter)
 *   const result = await subspace.search(queryEmb, options, personalInfluences)
 */
export class TruthSubspaceRetriever {
  private base: GraphCompletionRetriever
  private graph: GraphDB

  constructor(graph: GraphDB, base?: GraphCompletionRetriever) {
    this.graph = graph
    this.base = base ?? new GraphCompletionRetriever(graph)
  }

  /**
   * 带真值子空间偏置的检索
   *
   * @param queryEmbedding  查询向量
   * @param options         检索选项（同 GraphCompletionRetriever）
   * @param personalInfluences  实体名 → 个人偏好（0-1）。0.5 = 中性（无偏置），>0.5 偏好该实体，<0.5 排斥
   * @param subspaceStrength 子空间投影强度（0-1，默认 0.3）。越大查询向量越偏向偏好实体簇
   */
  async search(
    queryEmbedding: number[],
    options: GraphSearchOptions,
    personalInfluences?: Map<string, number>,
    subspaceStrength: number = 0.3
  ): Promise<CompletionResult> {
    const influences = personalInfluences ?? new Map()
    const active = [...influences.entries()].filter(([_, v]) => v !== 0.5)

    // 子空间投影：查询向量向偏好实体嵌入方向偏移
    let blended = queryEmbedding
    if (active.length > 0 && options.knowledgeBaseId) {
      const centroid = await this.computePreferenceCentroid(active, options.knowledgeBaseId)
      if (centroid) {
        const avgBias = active.reduce((s, [_, v]) => s + Math.abs(v - 0.5) * 2, 0) / active.length
        const beta = Math.min(1, subspaceStrength * avgBias)
        blended = queryEmbedding.map((v, i) => v * (1 - beta) + (centroid[i] ?? 0) * beta)
      }
    }

    const result = await this.base.search(blended, options)

    // 个人偏好加权：调整三元组距离分（距离空间，越小越重要）
    // 偏好实体（avg>0.5）→ 距离缩小 → 排名提前；排斥（avg<0.5）→ 距离放大
    if (active.length > 0) {
      for (const t of result.triplets) {
        const sw = influences.get(t.source.name) ?? 0.5
        const tw = influences.get(t.target.name) ?? 0.5
        const avg = (sw + tw) / 2
        t.score *= 1 - subspaceStrength * (avg - 0.5) * 2
      }
      result.triplets.sort((a, b) => a.score - b.score)
    }

    // 重建 context 字符串以反映新排序
    result.context = result.triplets
      .map((t) => `[${t.source.name}] --[${t.relation}]--> [${t.target.name}]`)
      .join('\n')

    return result
  }

  /** 计算偏好实体的加权嵌入质心 */
  private async computePreferenceCentroid(
    active: Array<[string, number]>,
    kb: string
  ): Promise<number[] | null> {
    const dim = active.length > 0 ? 64 : 0
    let sum: number[] = new Array(dim).fill(0)
    let totalWeight = 0
    let found = false

    for (const [name, influence] of active) {
      const node = await this.graph.findNodeByName(name, kb)
      if (!node?.embedding) continue
      const w = Math.abs(influence - 0.5) * 2 // 0→1 无量纲权
      for (let i = 0; i < node.embedding.length; i++) {
        sum[i] = (sum[i] ?? 0) + node.embedding[i] * w
      }
      totalWeight += w
      found = true
    }

    if (!found || totalWeight === 0) return null
    const dims = sum.length
    const centroid = new Array(64)
    for (let i = 0; i < 64; i++) {
      centroid[i] = (sum[i] ?? 0) / totalWeight
    }
    // 确保维度与 queryEmbedding 对齐（填充/截断由调用方处理）
    return centroid
  }
}