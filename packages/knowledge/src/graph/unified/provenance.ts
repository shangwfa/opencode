import { getDatabaseSchema } from '../../config/env.js'
import type { GraphDB } from '../interface.js'

export interface ProvenanceResult {
  deletedNodeIds: string[]
  deletedEdgeIds: string[]
}

export class ProvenanceDeletePlanner {
  private graph: GraphDB
  private schemaName: string

  constructor(graph: GraphDB, schemaName?: string) {
    this.graph = graph
    this.schemaName = schemaName || getDatabaseSchema()
  }

  private getSchema(): string {
    return this.schemaName
  }

  async executeSourceRefRemoval(
    sourceRefKey: string,
    knowledgeBaseId: string
  ): Promise<ProvenanceResult> {
    const nodeIds = await this.findNodesBySourceRef(sourceRefKey, knowledgeBaseId)
    if (nodeIds.length === 0) {
      return { deletedNodeIds: [], deletedEdgeIds: [] }
    }

    const graphData = await this.graph.getGraphData(knowledgeBaseId)
    const orphanedNodes = this.findOrphanedNodes(nodeIds, graphData.edges)

    const deletedEdgeIds: string[] = []
    for (const edge of graphData.edges) {
      if (orphanedNodes.includes(edge.sourceId) || orphanedNodes.includes(edge.targetId)) {
        await this.graph.deleteEdge(edge.sourceId, edge.targetId, edge.relationshipName)
        deletedEdgeIds.push(`${edge.sourceId}->${edge.targetId}[${edge.relationshipName}]`)
      }
    }

    await this.graph.deleteNodes(orphanedNodes)

    return {
      deletedNodeIds: orphanedNodes,
      deletedEdgeIds,
    }
  }

  async executeDatasetRemoval(
    datasetId: string,
    knowledgeBaseId: string
  ): Promise<ProvenanceResult> {
    const nodeIds = await this.findNodesByDataset(datasetId, knowledgeBaseId)
    if (nodeIds.length === 0) {
      return { deletedNodeIds: [], deletedEdgeIds: [] }
    }

    const graphData = await this.graph.getGraphData(knowledgeBaseId)
    const otherNodes = graphData.nodes
      .filter((n) => !nodeIds.includes(n.id))
      .map((n) => n.id)

    const sharedEdges = graphData.edges.filter(
      (e) =>
        nodeIds.includes(e.sourceId) &&
        nodeIds.includes(e.targetId)
    )

    const deletedEdgeIds: string[] = []
    for (const edge of sharedEdges) {
      await this.graph.deleteEdge(edge.sourceId, edge.targetId, edge.relationshipName)
      deletedEdgeIds.push(`${edge.sourceId}->${edge.targetId}[${edge.relationshipName}]`)
    }

    const orphanedNodes = this.findOrphanedNodes(nodeIds, graphData.edges)
    await this.graph.deleteNodes(orphanedNodes)

    return {
      deletedNodeIds: orphanedNodes,
      deletedEdgeIds,
    }
  }

  private findOrphanedNodes(nodeIds: string[], edges: Array<{ sourceId: string; targetId: string }>): string[] {
    const connectedNodeIds = new Set<string>()
    for (const edge of edges) {
      if (nodeIds.includes(edge.sourceId)) {
        connectedNodeIds.add(edge.targetId)
      }
      if (nodeIds.includes(edge.targetId)) {
        connectedNodeIds.add(edge.sourceId)
      }
    }

    return nodeIds.filter((id) => !connectedNodeIds.has(id))
  }

  private async findNodesBySourceRef(sourceRefKey: string, knowledgeBaseId: string): Promise<string[]> {
    const rows = await this.graph.query(
      `SELECT n.id FROM ${this.getSchema()}.graph_nodes n
       WHERE n.knowledge_base_id = $1
       AND n.properties @> $2::jsonb`,
      [knowledgeBaseId, JSON.stringify({ sourceRefKey })]
    )
    return (rows as any[]).map((r) => r.id)
  }

  private async findNodesByDataset(datasetId: string, knowledgeBaseId: string): Promise<string[]> {
    const rows = await this.graph.query(
      `SELECT n.id FROM ${this.getSchema()}.graph_nodes n
       WHERE n.knowledge_base_id = $1
       AND n.properties @> $2::jsonb`,
      [knowledgeBaseId, JSON.stringify({ datasetId })]
    )
    return (rows as any[]).map((r) => r.id)
  }
}