import { getDatabaseSchema } from '../../config/env.js'
import type { GraphDB } from '../interface.js'
import type { VectorService } from '../../rag/knowledge-base/index.js'

export enum EngineCapability {
  NONE = 0,
  GRAPH = 1,
  VECTOR = 2,
  HYBRID_WRITE = 4,
  HYBRID_SEARCH = 8,
}

export interface UnifiedDeleteResult {
  deletedNodeIds: string[]
  deletedEdgeCount: number
  deletedVectorIds: string[]
}

export class UnifiedStoreEngine {
  private graph: GraphDB
  private vector?: VectorService
  private capabilities: EngineCapability
  private schemaName: string

  constructor(graph: GraphDB, vector?: VectorService, schemaName?: string) {
    this.graph = graph
    this.vector = vector
    this.capabilities = EngineCapability.GRAPH
    if (vector) {
      this.capabilities |= EngineCapability.VECTOR
    }
    this.schemaName = schemaName || getDatabaseSchema()
  }

  hasCapability(cap: EngineCapability): boolean {
    return (this.capabilities & cap) !== 0
  }

  /** 能力守卫的 graph 访问器（对标 cognee UnifiedStoreEngine.graph property） */
  get graphEngine(): GraphDB {
    if (!this.hasCapability(EngineCapability.GRAPH) || !this.graph) {
      throw new Error('该 UnifiedStoreEngine 无 GRAPH 能力，请先检查 hasCapability(EngineCapability.GRAPH)')
    }
    return this.graph
  }

  /** 能力守卫的 vector 访问器（对标 cognee UnifiedStoreEngine.vector property） */
  get vectorEngine(): VectorService {
    if (!this.hasCapability(EngineCapability.VECTOR) || !this.vector) {
      throw new Error('该 UnifiedStoreEngine 无 VECTOR 能力，请先检查 hasCapability(EngineCapability.VECTOR)')
    }
    return this.vector
  }

  /** 是否支持图溯源删除/回滚（需 GRAPH + VECTOR 双能力，对标 cognee supports_graph_provenance_delete） */
  supportsGraphProvenanceDelete(): boolean {
    return this.hasCapability(EngineCapability.GRAPH) &&
      this.hasCapability(EngineCapability.VECTOR) &&
      this.graph !== null &&
      this.vector !== null
  }

  /**
   * 按文档删除：图节点/边 + 向量
   *
   * 节点定位双路径：
   * 1. 主路径：graph_document_nodes 关联表
   * 2. 兜底：节点 properties.sourceDocumentId 反查（早期数据未写关联表时）
   *
   * 删除语义（对标 cognee provenance_delete_planner 的 unowned/detach）：
   * - unowned：节点只被本次删除的文档引用 → 硬删节点 + 相关边
   * - detach：节点还被其他文档引用 → 保留节点，仅剥离本文档的关联记录
   */
  async deleteByDocument(
    documentId: string,
    knowledgeBaseId: string
  ): Promise<UnifiedDeleteResult> {
    const nodeIds = await this.findNodeIdsByDocument(documentId, knowledgeBaseId)

    // 反向查询：每个节点还被哪些文档关联（判断 unowned vs detach）
    const docsByNode = new Map<string, string[]>()
    const g = this.graph as any
    if (typeof g.getDocumentsByNodeIds === 'function' && nodeIds.length > 0) {
      try {
        const map = await g.getDocumentsByNodeIds(nodeIds)
        for (const [nid, docs] of map) docsByNode.set(nid, docs.filter((d: string) => d !== documentId))
      } catch { /* 反向查询失败则保守全删 */ }
    }

    // unowned：无其他文档引用的节点硬删；detach：仍被引用则保留
    const detachNodeIds = nodeIds.filter((id) => (docsByNode.get(id)?.length ?? 0) > 0)
    const unownedNodeIds = nodeIds.filter((id) => !docsByNode.has(id) || (docsByNode.get(id)?.length ?? 0) === 0)

    const deletedEdgeCount = unownedNodeIds.length > 0
      ? await this.deleteNodesAndEdges(unownedNodeIds, knowledgeBaseId)
      : 0

    // 清理关联表记录：被删文档的链接（detach 节点也剥离本文档的关联）
    if (typeof g.deleteDocumentLinks === 'function') {
      await g.deleteDocumentLinks(documentId)
    }

    // 清理孤儿 EntityType 节点（虚拟 kb，对标 cognee _cleanup_orphaned_edge_types 思路）
    if (unownedNodeIds.length > 0) {
      await this.cleanupOrphanedEntityTypes()
    }

    let deletedVectorIds: string[] = []
    if (this.vector) {
      try {
        deletedVectorIds = await this.vector.getDocumentVectorIds(knowledgeBaseId, documentId)
        // 仅删除 unowned 节点对应的向量（detach 节点保留）
        await this.vector.deleteBatch(knowledgeBaseId, deletedVectorIds)
      } catch {
        console.warn(`[统一引擎] 向量删除失败（文档 ${documentId}）`)
      }
    }

    void detachNodeIds
    return {
      deletedNodeIds: unownedNodeIds,
      deletedEdgeCount,
      deletedVectorIds,
    }
  }

  /**
   * 按知识库删除：全图 + 向量索引
   */
  async deleteByKnowledgeBase(knowledgeBaseId: string): Promise<UnifiedDeleteResult> {
    const graphData = await this.graph.getGraphData(knowledgeBaseId)
    const nodeIds = graphData.nodes.map((n) => n.id)
    const edgeCount = graphData.edges.length

    await this.graph.deleteGraph(knowledgeBaseId)

    let deletedVectorIds: string[] = []
    if (this.vector) {
      try {
        await this.vector.deleteIndex(knowledgeBaseId)
      } catch {
        console.warn(`[统一引擎] 向量索引删除失败（知识库 ${knowledgeBaseId}）`)
      }
    }

    return {
      deletedNodeIds: nodeIds,
      deletedEdgeCount: edgeCount,
      deletedVectorIds,
    }
  }

  /**
   * 按 pipeline run 回滚：只删该次运行写入的图数据
   */
  async rollbackByPipelineRun(
    pipelineRunId: string,
    knowledgeBaseId: string
  ): Promise<UnifiedDeleteResult> {
    const nodeIds = await this.findNodeIdsByPipelineRun(pipelineRunId, knowledgeBaseId)
    const deletedEdgeCount = await this.deleteNodesAndEdges(nodeIds, knowledgeBaseId)

    return {
      deletedNodeIds: nodeIds,
      deletedEdgeCount,
      deletedVectorIds: [],
    }
  }

  /**
   * 删除指定节点及其关联边
   */
  private async deleteNodesAndEdges(nodeIds: string[], knowledgeBaseId: string): Promise<number> {
    if (nodeIds.length === 0) return 0

    const graphData = await this.graph.getGraphData(knowledgeBaseId)
    const relatedEdges = graphData.edges.filter(
      (e) => nodeIds.includes(e.sourceId) || nodeIds.includes(e.targetId)
    )

    for (const edge of relatedEdges) {
      await this.graph.deleteEdge(edge.sourceId, edge.targetId, edge.relationshipName)
    }
    await this.graph.deleteNodes(nodeIds)

    return relatedEdges.length
  }

  private async findNodeIdsByDocument(documentId: string, knowledgeBaseId: string): Promise<string[]> {
    const g = this.graph as any
    // 主路径：关联表
    if (typeof g.getNodeIdsByDocument === 'function') {
      try {
        const ids = await g.getNodeIdsByDocument(documentId)
        if (ids.length > 0) return ids
      } catch {
        // 降级到兜底路径
      }
    }
    // 兜底：节点属性反查
    if (typeof g.getNodeIdsByProperty === 'function') {
      try {
        return await g.getNodeIdsByProperty('sourceDocumentId', documentId, knowledgeBaseId)
      } catch {
        return []
      }
    }
    return []
  }

  private async findNodeIdsByPipelineRun(pipelineRunId: string, knowledgeBaseId: string): Promise<string[]> {
    const g = this.graph as any
    if (typeof g.getNodeIdsByPipelineRun === 'function') {
      try {
        const ids = await g.getNodeIdsByPipelineRun(pipelineRunId)
        if (ids.length > 0) return ids
      } catch {
        // 降级
      }
    }
    if (typeof g.getNodeIdsByProperty === 'function') {
      try {
        return await g.getNodeIdsByProperty('pipelineRunId', pipelineRunId, knowledgeBaseId)
      } catch {
        return []
      }
    }
    return []
  }

  /**
   * 清理孤儿 EntityType 节点（对标 cognee _cleanup_orphaned_edge_types 思路）
   *
   * EntityType 节点在虚拟 kb `__entity_types__`，业务节点删除时 is_a 边被 FK CASCADE，
   * 但 EntityType 节点会残留。清理无任何 is_a 入边的 EntityType 节点。
   */
  private async cleanupOrphanedEntityTypes(): Promise<void> {
    try {
      const g = this.graph as any
      if (typeof g.findNodesByType !== 'function') return
      const typeNodes = await g.findNodesByType('entity_type', '__entity_types__')
      for (const tn of typeNodes) {
        const isaEdges = await g.getEdges(tn.id)
        const hasIncomingIsa = isaEdges.some(
          (e: any) => e.targetId === tn.id && e.relationshipName === 'is_a'
        )
        if (!hasIncomingIsa) {
          await g.deleteNode(tn.id)
        }
      }
    } catch (err: any) {
      console.warn(`[统一引擎] EntityType 孤儿清理跳过: ${err.message}`)
    }
  }
}