import type { GraphDB } from '../interface.js'
import type { GraphNode, GraphEdge, Triplet } from '../types.js'
import {
  createGraphElementNode,
  createGraphElementEdge,
  type GraphElementNode,
  type GraphElementEdge,
  isAlive,
} from './graph-elements.js'

/**
 * 内存图投影与三元组重要性计算（对标 cognee CogneeGraph.py）
 *
 * 评分语义（与 cognee _calculate_query_top_triplet_importances 对齐）：
 * - 排序在"距离空间"进行：得分 = 三元组两端节点 + 边自身，三个元素的加权距离之和
 * - 距离越小越重要 → 取 score 最小的 topK
 * - 无向量距离的元素使用 triplet_distance_penalty 兜底（垫底而非冲顶）
 * - importance_weight（默认 0.5）：距离乘 (2 - importance_weight)
 * - feedback_weight（默认 0.5 中性）：在距离空间线性混合，仅作用于真实余弦距离 [0,2]
 * - personal_weight（默认 undefined 中性）：距离空间乘法因子 1 - personalInfluence*(2w-1)
 */
export class CogneeGraph {
  nodes: Map<string, GraphElementNode> = new Map()
  edges: GraphElementEdge[] = []
  edgesByType: Map<string, GraphElementEdge[]> = new Map()
  directed: boolean
  tripletDistancePenalty: number
  feedbackInfluence: number
  personalInfluence: number

  constructor(options?: {
    directed?: boolean
    tripletDistancePenalty?: number
    feedbackInfluence?: number
    personalInfluence?: number
  }) {
    this.directed = options?.directed ?? true // 对标 cognee 默认 directed=True
    this.tripletDistancePenalty = options?.tripletDistancePenalty ?? 6.5 // 对标 cognee 默认 6.5
    this.feedbackInfluence = options?.feedbackInfluence ?? 0.3
    this.personalInfluence = options?.personalInfluence ?? 0.2
  }

  addNode(node: GraphNode): void {
    if (this.nodes.has(node.id)) return
    const elementNode = createGraphElementNode(node)
    elementNode.distance = this.tripletDistancePenalty // 未命中向量距离前先垫底
    this.nodes.set(node.id, elementNode)
  }

  addEdge(edge: GraphEdge): void {
    const sourceNode = this.nodes.get(edge.sourceId)
    const targetNode = this.nodes.get(edge.targetId)
    if (!sourceNode || !targetNode) return

    const elementEdge = createGraphElementEdge(edge, sourceNode, targetNode, this.directed)
    elementEdge.distance = this.tripletDistancePenalty
    this.edges.push(elementEdge)

    if (!this.edgesByType.has(elementEdge.edgeTypeId)) {
      this.edgesByType.set(elementEdge.edgeTypeId, [])
    }
    this.edgesByType.get(elementEdge.edgeTypeId)!.push(elementEdge)

    sourceNode.skeletonEdges.push(elementEdge)
    targetNode.skeletonEdges.push(elementEdge)
    sourceNode.skeletonNeighbours.push(targetNode)
    targetNode.skeletonNeighbours.push(sourceNode)
  }

  async projectNeighborhoodFromDb(
    adapter: GraphDB,
    seedIds: string[],
    maxDepth: number = 2,
    edgeTypes?: string[],
    knowledgeBaseId?: string
  ): Promise<void> {
    // knowledgeBaseId 必须透传：共享实体类型节点（如 __entity_types__）是跨库共享的，
    // 不带库过滤会把其它知识库经类型节点可达的关系投进本库检索结果。
    const subgraph = await adapter.getNeighborhood({ seedIds, maxDepth, edgeTypes, knowledgeBaseId })
    for (const node of subgraph.nodes) {
      this.addNode(node)
    }
    for (const edge of subgraph.edges) {
      this.addEdge(edge)
    }
  }

  /** 节点级向量距离映射（仅覆盖有 embedding 的节点，其余保持 penalty） */
  mapVectorDistancesToNodes(queryEmbedding: number[], embeddings: Map<string, number[]>): void {
    for (const [nodeId, node] of this.nodes) {
      const emb = embeddings.get(nodeId)
      if (emb) {
        node.distance = cosineDistance(queryEmbedding, emb)
      }
    }
  }

  /** 边级向量距离映射：两端节点距离的平均（对标 cognee map_vector_distances_to_graph_edges） */
  mapVectorDistancesToEdges(queryEmbedding: number[], embeddings: Map<string, number[]>): void {
    for (const edge of this.edges) {
      const node1Emb = embeddings.get(edge.node1.id)
      const node2Emb = embeddings.get(edge.node2.id)
      if (node1Emb && node2Emb) {
        const d1 = cosineDistance(queryEmbedding, node1Emb)
        const d2 = cosineDistance(queryEmbedding, node2Emb)
        edge.distance = (d1 + d2) / 2
      }
    }
  }

  applyPersonalWeights(weights: Map<string, number>): void {
    for (const [nodeId, node] of this.nodes) {
      const w = weights.get(nodeId)
      if (w !== undefined) {
        node.personalWeight = w
      }
    }
  }

  /**
   * 应用反馈权重（对标 cognee feedback_weight，默认 0.5 中性）
   * 归一化到 [0,1]：weight = 0.5 + (positive - negative) / 2
   */
  applyFeedbackWeights(weights: Map<string, { positive: number; negative: number }>): void {
    for (const [nodeId, node] of this.nodes) {
      const w = weights.get(nodeId)
      if (w) {
        node.feedbackWeight = 0.5 + (w.positive - w.negative) / 2
      }
    }
  }

  /**
   * 计算 topK 三元组（按距离空间得分升序，取最小）
   *
   * 对标 cognee _calculate_query_top_triplet_importances：
   * - 遍历每条边，对 (node1, node2, edge) 三个元素
   *   - distance ← (2 - importance_weight) * distance
   *   - 反馈混合（仅作用于真实余弦距离 [0,2]）：
   *       blended = (1 - fb) * d_norm + fb * (1 - fb_weight)，d_norm = d / 2
   *   - 个人化：blended * (1 - personalInfluence * (2 * pw - 1))（pw 未设置则跳过）
   *   - 三元素贡献求和 → edge score
   * - 返回 score 最小的 topK 条
   */
  calculateTopTripletImportances(
    topK: number = 10,
    options?: {
      alpha?: number
      beta?: number
      gamma?: number
    }
  ): Triplet[] {
    // 注：cognee 原版不直接用 alpha/beta/gamma 加权，importance_weight 承担权重。
    // 保留这些参数以兼容调用方透传，但仅在 importanceWeight 未显式设置时提供默认。
    void options

    const scored: Array<{ triplet: Triplet; score: number }> = []

    for (const edge of this.edges) {
      if (!isAlive(edge.node1) || !isAlive(edge.node2)) continue

      const score = this.scoreEdge(edge)
      if (!Number.isFinite(score)) continue

      const edgeAttrs = edge.attributes as Record<string, unknown>
      scored.push({
        triplet: {
          source: this.toTripletNode(edge.node1),
          relation: (edgeAttrs.relationshipName as string) || '',
          target: this.toTripletNode(edge.node2),
          weight: (edgeAttrs.weight as number) || 1,
          score,
        },
        score,
      })
    }

    // 距离空间：score 越小越重要
    scored.sort((a, b) => a.score - b.score)
    return scored.slice(0, topK).map((s) => s.triplet)
  }

  /** 单条边的距离空间得分（对标 cognee score()） */
  private scoreEdge(edge: GraphElementEdge): number {
    const penalty = this.tripletDistancePenalty
    const elements: Array<{ distance: number; weight: number; feedback: number; personal: number | undefined }> = [
      this.elementDistance(edge.node1, penalty),
      this.elementDistance(edge.node2, penalty),
      this.elementDistance(edge, penalty),
    ]

    let total = 0
    for (const el of elements) {
      // 反馈混合：仅在真实余弦距离 [0,2] 内生效，fallback penalty 保持不变
      let blended = this.effectiveDistance(el.distance, el.feedback)
      // 个人化：距离空间乘法因子（pw 未设置则 no-op）
      blended = this.personalDistance(el.distance, blended, el.personal)
      total += blended
    }
    return total
  }

  /** 提取元素的 (importance 加权距离, 反馈权重, 个人权重) */
  private elementDistance(
    element: GraphElementNode | GraphElementEdge,
    penalty: number
  ): { distance: number; weight: number; feedback: number; personal: number | undefined } {
    const raw = element.distance
    const effective = Number.isFinite(raw) && raw >= 0 ? raw : penalty
    const importance = element.importanceWeight ?? 0.5
    const weighted = (2 - importance) * effective
    return {
      distance: weighted,
      weight: importance,
      feedback: element.feedbackWeight ?? 0.5,
      personal: element.personalWeight,
    }
  }

  /** 反馈混合（对标 cognee _effective_distance） */
  private effectiveDistance(distance: number, feedbackWeight: number): number {
    if (this.feedbackInfluence <= 0) return distance
    // 仅混合真实余弦距离 [0,2]；penalty 兜底保持原样垫底
    if (distance >= 2 || distance < 0) return distance
    const fb = Math.max(0, Math.min(1, feedbackWeight))
    const normalized = distance / 2
    const blended = (1 - this.feedbackInfluence) * normalized + this.feedbackInfluence * (1 - fb)
    return blended * 2
  }

  /** 个人化（对标 cognee _personal_distance 距离空间） */
  private personalDistance(raw: number, blended: number, personalWeight: number | undefined): number {
    if (this.personalInfluence <= 0 || personalWeight === undefined) return blended
    // 与 effectiveDistance 同样的 eligibility：raw 决定，blended 决定值
    if (raw >= 2 || raw < 0) return blended
    const factor = 1 - this.personalInfluence * (2 * personalWeight - 1)
    return blended * factor
  }

  private toTripletNode(node: GraphElementNode): Triplet['source'] {
    const attrs = node.attributes as Record<string, unknown>
    return {
      id: node.id,
      knowledgeBaseId: (attrs.knowledgeBaseId as string) || '',
      name: (attrs.name as string) || '',
      type: (attrs.type as string) || 'entity',
      properties: attrs,
      frequency: (attrs.frequency as number) || 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
  }

  getNode(id: string): GraphElementNode | undefined {
    return this.nodes.get(id)
  }

  getEdges(nodeId: string): GraphElementEdge[] {
    const node = this.nodes.get(nodeId)
    if (!node) return []
    return node.skeletonEdges
  }

  getNeighbors(nodeId: string): GraphElementNode[] {
    const node = this.nodes.get(nodeId)
    if (!node) return []
    return node.skeletonNeighbours
  }
}

function cosineDistance(a: number[], b: number[]): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const similarity = dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1)
  return 1 - similarity
}
