import type { GraphDB } from '../interface.js'
import type { GraphNode, GraphEdge } from '../types.js'

export interface VisualizationNode {
  id: string
  label: string
  type: string
  group: string
  size: number
  properties: Record<string, unknown>
}

export interface VisualizationEdge {
  source: string
  target: string
  label: string
  weight: number
}

export interface VisualizationData {
  nodes: VisualizationNode[]
  edges: VisualizationEdge[]
  metadata: {
    nodeCount: number
    edgeCount: number
    typeDistribution: Record<string, number>
  }
}

export class GraphVisualizer {
  private graph: GraphDB

  constructor(graph: GraphDB) {
    this.graph = graph
  }

  async getVisualizationData(knowledgeBaseId?: string): Promise<VisualizationData> {
    const graphData = await this.graph.getGraphData(knowledgeBaseId)
    const metrics = await this.graph.getGraphMetrics(knowledgeBaseId)

    const nodes: VisualizationNode[] = graphData.nodes.map((node) => ({
      id: node.id,
      label: node.name,
      type: node.type,
      group: node.type,
      size: Math.min(10 + node.frequency * 2, 50),
      properties: node.properties,
    }))

    const edges: VisualizationEdge[] = graphData.edges.map((edge) => ({
      source: edge.sourceId,
      target: edge.targetId,
      label: edge.relationshipName,
      weight: edge.weight,
    }))

    return {
      nodes,
      edges,
      metadata: {
        nodeCount: metrics.nodeCount,
        edgeCount: metrics.edgeCount,
        typeDistribution: metrics.nodeTypeDistribution,
      },
    }
  }

  async getNeighborhoodViz(
    seedIds: string[],
    maxDepth: number = 2,
    knowledgeBaseId?: string
  ): Promise<VisualizationData> {
    const subgraph = await this.graph.getNeighborhood({
      seedIds,
      maxDepth,
      knowledgeBaseId,
    })

    const nodes: VisualizationNode[] = subgraph.nodes.map((node) => ({
      id: node.id,
      label: node.name,
      type: node.type,
      group: node.type,
      size: 20,
      properties: node.properties,
    }))

    const edges: VisualizationEdge[] = subgraph.edges.map((edge) => ({
      source: edge.sourceId,
      target: edge.targetId,
      label: edge.relationshipName,
      weight: edge.weight,
    }))

    return {
      nodes,
      edges,
      metadata: {
        nodeCount: nodes.length,
        edgeCount: edges.length,
        typeDistribution: this.getTypeDistribution(subgraph.nodes),
      },
    }
  }

  private getTypeDistribution(nodes: GraphNode[]): Record<string, number> {
    const dist: Record<string, number> = {}
    for (const node of nodes) {
      dist[node.type] = (dist[node.type] || 0) + 1
    }
    return dist
  }
}

export { SemanticMapLayout } from './semantic-map.js'