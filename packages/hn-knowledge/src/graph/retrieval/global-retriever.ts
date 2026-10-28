import type { GraphDB } from '../interface.js'
import type { GraphNode, GraphEdge, Triplet } from '../types.js'

export interface GlobalGraphSearchOptions {
  topK: number
  knowledgeBaseId?: string
  relationTypes?: string[]
  excludeRelationTypes?: string[]
  minWeight?: number
}

export interface GlobalGraphResult {
  triplets: Triplet[]
  context: string
  topRelations: GraphEdge[]
}

/**
 * 全局模式图检索器（对标 LightRAG global mode）
 *
 * 语义：以关系为中心。从关系集合中检索与查询最相关的三元组，
 * 不依赖种子实体邻域投影。适合"概述/总结/主题"类查询。
 */
export class GlobalGraphRetriever {
  private graph: GraphDB

  constructor(graph: GraphDB) {
    this.graph = graph
  }

  async search(
    queryEmbedding: number[],
    options: GlobalGraphSearchOptions
  ): Promise<GlobalGraphResult> {
    const { topK, knowledgeBaseId, minWeight } = options

    const graphData = await this.graph.getGraphData(knowledgeBaseId)
    if (graphData.edges.length === 0) {
      return { triplets: [], context: '', topRelations: [] }
    }

    const nodesById = new Map(graphData.nodes.map((n) => [n.id, n]))

    // 过滤
    const allowed = options.relationTypes?.length ? new Set(options.relationTypes) : undefined
    const excluded = new Set(['is_a', ...(options.excludeRelationTypes || [])])

    // 对每条边，用两端节点 embedding 计算与查询的相关度
    const scored = graphData.edges
      .filter((e) =>
        (!allowed || allowed.has(e.relationshipName)) &&
        !excluded.has(e.relationshipName) &&
        (minWeight === undefined || e.weight >= minWeight) &&
        nodesById.has(e.sourceId) &&
        nodesById.has(e.targetId)
      )
      .map((e) => {
        const source = nodesById.get(e.sourceId)!
        const target = nodesById.get(e.targetId)!

        // 相关度：两端节点 embedding 与查询的 cosine 均值 × 边权重
        const sourceSim = source.embedding ? cosineSimilarity(queryEmbedding, source.embedding) : 0
        const targetSim = target.embedding ? cosineSimilarity(queryEmbedding, target.embedding) : 0
        const relevance = (sourceSim + targetSim) / 2 * e.weight

        return { edge: e, source, target, relevance }
      })
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, topK)

    const triplets: Triplet[] = scored.map((s) => ({
      source: s.source,
      relation: s.edge.relationshipName,
      target: s.target,
      weight: s.edge.weight,
      score: 1 - s.relevance, // 距离空间
    }))

    const context = triplets
      .map((t) => `[${t.source.name}] --[${t.relation}]--> [${t.target.name}]`)
      .join('\n')

    return {
      triplets,
      context,
      topRelations: scored.map((s) => s.edge),
    }
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1)
}