import type { GraphDB } from '../interface.js'
import type { Triplet } from '../types.js'
import { LocalGraphRetriever, type LocalGraphResult } from './local-retriever.js'
import { GlobalGraphRetriever, type GlobalGraphResult } from './global-retriever.js'

export interface RoundRobinHybridOptions {
  topK: number
  knowledgeBaseId?: string
  excludeTypes?: string[]
  relationTypes?: string[]
  excludeRelationTypes?: string[]
  /** local 模式占比（0-1，默认 0.5），剩余给 global */
  localRatio?: number
}

export interface RoundRobinHybridResult {
  triplets: Triplet[]
  context: string
  localResult: LocalGraphResult
  globalResult: GlobalGraphResult
}

/**
 * Round-robin 混合检索器（对标 LightRAG hybrid mode）
 *
 * 同时执行 local（实体为中心）和 global（关系为中心）检索，
 * 用 round-robin 方式合并结果，保证两种模式均衡贡献。
 */
export class RoundRobinHybridRetriever {
  private local: LocalGraphRetriever
  private global: GlobalGraphRetriever

  constructor(graph: GraphDB) {
    this.local = new LocalGraphRetriever(graph)
    this.global = new GlobalGraphRetriever(graph)
  }

  async search(
    queryEmbedding: number[],
    options: RoundRobinHybridOptions
  ): Promise<RoundRobinHybridResult> {
    const { topK, localRatio = 0.5 } = options
    const localTopK = Math.max(1, Math.ceil(topK * localRatio))
    const globalTopK = Math.max(1, topK - localTopK)

    const [localResult, globalResult] = await Promise.all([
      this.local.search(queryEmbedding, {
        topK: localTopK * 2,
        knowledgeBaseId: options.knowledgeBaseId,
        excludeTypes: options.excludeTypes,
        relationTypes: options.relationTypes,
        excludeRelationTypes: options.excludeRelationTypes,
      }),
      this.global.search(queryEmbedding, {
        topK: globalTopK * 2,
        knowledgeBaseId: options.knowledgeBaseId,
        relationTypes: options.relationTypes,
        excludeRelationTypes: options.excludeRelationTypes,
      }),
    ])

    const merged = this.roundRobinMerge(localResult.triplets, globalResult.triplets, topK)

    const context = merged
      .map((t) => `[${t.source.name}] --[${t.relation}]--> [${t.target.name}]`)
      .join('\n')

    return { triplets: merged, context, localResult, globalResult }
  }

  private roundRobinMerge(local: Triplet[], global: Triplet[], topK: number): Triplet[] {
    const seen = new Set<string>()
    const result: Triplet[] = []
    let li = 0, gi = 0

    while (result.length < topK && (li < local.length || gi < global.length)) {
      if (li < local.length) {
        const t = local[li++]
        const key = `${t.source.id}|${t.relation}|${t.target.id}`
        if (!seen.has(key)) { seen.add(key); result.push(t) }
      }
      if (result.length >= topK) break
      if (gi < global.length) {
        const t = global[gi++]
        const key = `${t.source.id}|${t.relation}|${t.target.id}`
        if (!seen.has(key)) { seen.add(key); result.push(t) }
      }
    }
    return result
  }
}