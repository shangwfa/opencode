import type { GraphDB } from '../interface.js'
import type { GraphNode, GraphEdge, Triplet } from '../types.js'

export interface LocalGraphSearchOptions {
  topK: number
  knowledgeBaseId?: string
  excludeTypes?: string[]
  relationTypes?: string[]
  excludeRelationTypes?: string[]
  sourceTypes?: string[]
  targetTypes?: string[]
}

export interface LocalGraphResult {
  triplets: Triplet[]
  context: string
  seedEntities: GraphNode[]
  relatedEdges: GraphEdge[]
}

/**
 * 本地模式图检索器（对标 LightRAG local mode）
 *
 * 语义：以实体为中心。从实体 VDB 检索与查询最相关的种子实体，
 * 然后找到这些实体的关联关系返回。适合"实体 X 是什么/有什么属性"类查询。
 */
export class LocalGraphRetriever {
  private graph: GraphDB

  constructor(graph: GraphDB) {
    this.graph = graph
  }

  async search(
    queryEmbedding: number[],
    options: LocalGraphSearchOptions
  ): Promise<LocalGraphResult> {
    const { topK, knowledgeBaseId } = options

    const seedNodes = await this.findSeedNodes(queryEmbedding, knowledgeBaseId, topK * 2, options.excludeTypes)
    if (seedNodes.length === 0) {
      return { triplets: [], context: '', seedEntities: [], relatedEdges: [] }
    }

    const seedIds = new Set(seedNodes.map((n) => n.id))

    // 找到种子节点的所有关联关系
    const allEdges = await this.getEdgesForNodes([...seedIds], knowledgeBaseId)

    // 按关系类型过滤
    const allowed = options.relationTypes?.length ? new Set(options.relationTypes) : undefined
    const excluded = new Set(['is_a', ...(options.excludeRelationTypes || [])])
    const filteredEdges = allEdges.filter((e) =>
      (!allowed || allowed.has(e.relationshipName)) &&
      !excluded.has(e.relationshipName)
    )

    // 对边排序：按 weight 降序，取 topK
    const topEdges = [...filteredEdges]
      .sort((a, b) => b.weight - a.weight)
      .slice(0, topK)

    // 构建三元组
    const nodesById = new Map<string, GraphNode>()
    for (const n of seedNodes) nodesById.set(n.id, n)
    // 补充关联节点
    for (const e of topEdges) {
      if (!nodesById.has(e.sourceId)) {
        const n = await this.graph.getNode(e.sourceId)
        if (n) nodesById.set(n.id, n)
      }
      if (!nodesById.has(e.targetId)) {
        const n = await this.graph.getNode(e.targetId)
        if (n) nodesById.set(n.id, n)
      }
    }

    const triplets: Triplet[] = topEdges
      .map((e) => {
        const source = nodesById.get(e.sourceId)
        const target = nodesById.get(e.targetId)
        if (!source || !target) return null
        return {
          source,
          relation: e.relationshipName,
          target,
          weight: e.weight,
          score: 1 - e.weight, // 距离空间：weight 越高 score 越小
        } as Triplet
      })
      .filter((t): t is Triplet => t !== null)

    const context = triplets
      .map((t) => `[${t.source.name}] --[${t.relation}]--> [${t.target.name}]`)
      .join('\n')

    return {
      triplets,
      context,
      seedEntities: seedNodes,
      relatedEdges: topEdges,
    }
  }

  private async findSeedNodes(
    queryEmbedding: number[],
    knowledgeBaseId?: string,
    maxCandidates: number = 20,
    excludeTypes?: string[]
  ): Promise<GraphNode[]> {
    const g = this.graph as any
    if (typeof g.findSimilarNodesByEmbedding === 'function') {
      try {
        const nodes = await g.findSimilarNodesByEmbedding({
          embedding: queryEmbedding,
          topK: maxCandidates,
          knowledgeBaseId,
          excludeTypes,
        })
        if (nodes.length > 0) return nodes
      } catch { /* 降级 */ }
    }

    const graphData = await this.graph.getGraphData(knowledgeBaseId)
    const filtered = excludeTypes?.length
      ? graphData.nodes.filter((n) => !excludeTypes.includes(n.type))
      : graphData.nodes

    return filtered
      .map((node) => ({
        node,
        score: node.embedding ? cosineSimilarity(queryEmbedding, node.embedding) : 0,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, maxCandidates)
      .map((s) => s.node)
  }

  private async getEdgesForNodes(nodeIds: string[], knowledgeBaseId?: string): Promise<GraphEdge[]> {
    const allEdges: GraphEdge[] = []
    const seen = new Set<string>()
    for (const id of nodeIds) {
      const edges = await this.graph.getEdges(id)
      for (const e of edges) {
        const key = `${e.sourceId}|${e.relationshipName}|${e.targetId}`
        if (!seen.has(key)) {
          seen.add(key)
          allEdges.push(e)
        }
      }
    }
    // 如果有 knowledgeBaseId 过滤，只保留同 kb 的边
    if (knowledgeBaseId) {
      return allEdges.filter((e) => e.knowledgeBaseId === knowledgeBaseId)
    }
    return allEdges
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