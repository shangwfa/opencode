import type { GraphDB } from '../interface.js'

/**
 * EdgeType 索引器（对标 cognee EdgeType.py + tasks/storage/index_graph_edges.py）
 *
 * 为每种关系名维护一个统计节点（type='edge_type'）：
 * - name = 关系名
 * - properties.number_of_edges = 该关系类型的边数
 *
 * 用途：检索时按边类型过滤、图统计、可视化图例。
 * 建议在图谱构建/合并后调用 refresh()。
 */
export class EdgeTypeIndexer {
  private graph: GraphDB
  /** EdgeType 节点统一归属的虚拟知识库 ID */
  static readonly EDGE_TYPE_KB = '__edge_types__'

  constructor(graph: GraphDB) {
    this.graph = graph
  }

  /**
   * 刷新全量 EdgeType 统计节点（幂等）
   */
  async refresh(knowledgeBaseId?: string): Promise<{ typeCount: number }> {
    const metrics = await this.graph.getGraphMetrics(knowledgeBaseId)
    const relDist = metrics.relationshipDistribution

    for (const [relName, count] of Object.entries(relDist)) {
      await this.graph.addNode({
        knowledgeBaseId: EdgeTypeIndexer.EDGE_TYPE_KB,
        name: relName,
        type: 'edge_type',
        frequency: count,
        properties: {
          number_of_edges: count,
          ...(knowledgeBaseId ? { sourceKnowledgeBaseId: knowledgeBaseId } : {}),
        },
      })
    }

    return { typeCount: Object.keys(relDist).length }
  }

  /**
   * 查询边类型统计
   */
  async listEdgeTypes(): Promise<Array<{ name: string; count: number }>> {
    const nodes = await this.graph.findNodesByType('edge_type', EdgeTypeIndexer.EDGE_TYPE_KB)
    return nodes
      .map((n) => ({
        name: n.name,
        count: Number(n.properties?.number_of_edges || n.frequency || 0),
      }))
      .sort((a, b) => b.count - a.count)
  }

  /**
   * 给实体节点打 node set 标签（对标 belongs_to_set，供 getSubgraphByNodeSetLabel 使用）
   */
  async tagNodesWithSet(nodeIds: string[], nodeSetLabel: string): Promise<void> {
    for (const nodeId of nodeIds) {
      const node = await this.graph.getNode(nodeId)
      if (!node) continue
      const existing = Array.isArray(node.properties?.belongsToSet)
        ? (node.properties.belongsToSet as string[])
        : []
      if (existing.includes(nodeSetLabel)) continue
      await this.graph.updateNode(nodeId, {
        properties: {
          ...node.properties,
          belongsToSet: [...existing, nodeSetLabel],
        },
      })
    }
  }
}