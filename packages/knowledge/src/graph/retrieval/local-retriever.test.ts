import { describe, expect, it, mock } from 'bun:test'
import { LocalGraphRetriever } from './local-retriever.js'
import type { GraphDB } from '../interface.js'
import type { GraphNode, GraphEdge } from '../types.js'

function makeNode(id: string, name: string, type = 'entity', embedding?: number[]): GraphNode {
  return {
    id, knowledgeBaseId: 'kb_1', name, type,
    properties: {}, frequency: 1,
    embedding,
    createdAt: new Date(), updatedAt: new Date(),
  }
}

function makeEdge(s: string, t: string, rel: string, w = 1): GraphEdge {
  return {
    sourceId: s, targetId: t, relationshipName: rel,
    properties: {}, weight: w, knowledgeBaseId: 'kb_1',
    createdAt: new Date(), updatedAt: new Date(),
  }
}

function mockGraph(nodes: GraphNode[], edges: GraphEdge[]): GraphDB {
  const nodesById = new Map(nodes.map((n) => [n.id, n]))
  const edgesByNode = new Map<string, GraphEdge[]>()
  for (const e of edges) {
    if (!edgesByNode.has(e.sourceId)) edgesByNode.set(e.sourceId, [])
    if (!edgesByNode.has(e.targetId)) edgesByNode.set(e.targetId, [])
    edgesByNode.get(e.sourceId)!.push(e)
    edgesByNode.get(e.targetId)!.push(e)
  }

  return {
    supportsCypherQueries: false,
    query: mock(),
    isGraphEmpty: mock(),
    addNode: mock(),
    addNodes: mock(),
    getNode: mock(async (id) => nodesById.get(id) || null),
    getNodes: mock(async (ids) => ids.map((id: any) => nodesById.get(id)).filter(Boolean)),
    deleteNode: mock(),
    deleteNodes: mock(),
    updateNode: mock(),
    findNodeByName: mock(),
    findNodesByType: mock(),
    addEdge: mock(),
    addEdges: mock(),
    getEdges: mock(async (nodeId) => edgesByNode.get(nodeId) || []),
    hasEdge: mock(),
    hasEdges: mock(),
    deleteEdge: mock(),
    getNeighbors: mock(),
    getNeighborhood: mock(),
    getConnections: mock(),
    getSubgraph: mock(),
    findPaths: mock(),
    getGraphData: mock(async () => ({ nodes, edges })),
    getFilteredGraphData: mock(),
    getGraphMetrics: mock(),
    deleteGraph: mock(),
    getNodeCount: mock(),
    getEdgeCount: mock(),
    getNodeFeedbackWeights: mock(),
    setNodeFeedbackWeights: mock(),
    getEdgeFeedbackWeights: mock(),
    setEdgeFeedbackWeights: mock(),
    getNodeTruthState: mock(),
    setNodeTruthState: mock(),
    findSimilarNodesByEmbedding: mock(async (input: any) => {
      const candidates = nodes.filter((n) => n.embedding && !input.excludeTypes?.includes(n.type))
      return candidates
        .map((n) => ({ node: n, sim: cosineSimilarity(input.embedding, n.embedding!) }))
        .sort((a, b) => b.sim - a.sim)
        .slice(0, input.topK)
        .map((s) => s.node)
    }),
  } as unknown as GraphDB
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1)
}

describe('LocalGraphRetriever', () => {
  it('从种子实体出发检索邻域关系', async () => {
    const nodes = [
      makeNode('1', 'Python', 'language', [0.9, 0.1, 0]),
      makeNode('2', 'FastAPI', 'framework', [0.1, 0.9, 0.1]),
      makeNode('3', 'Django', 'framework', [0.2, 0.8, 0.2]),
    ]
    const edges = [
      makeEdge('1', '2', '用于', 0.9),
      makeEdge('1', '3', '对比', 0.5),
    ]
    const graph = mockGraph(nodes, edges)
    const retriever = new LocalGraphRetriever(graph)

    const result = await retriever.search([1, 0, 0], { topK: 5, knowledgeBaseId: 'kb_1' })

    expect(result.seedEntities.length).toBeGreaterThan(0)
    expect(result.triplets.length).toBe(2)
    expect(result.triplets[0].source.name).toBe('Python')
    expect(result.triplets[0].relation).toBe('用于')
    expect(result.triplets[0].target.name).toBe('FastAPI')
  })

  it('空图返回空结果', async () => {
    const graph = mockGraph([], [])
    const retriever = new LocalGraphRetriever(graph)
    const result = await retriever.search([1, 0, 0], { topK: 5, knowledgeBaseId: 'kb_1' })
    expect(result.triplets).toEqual([])
    expect(result.seedEntities).toEqual([])
  })

  it('按关系类型过滤', async () => {
    const nodes = [
      makeNode('1', 'Python', 'language', [0.9, 0, 0]),
      makeNode('2', 'FastAPI', 'framework', [0.1, 0.9, 0]),
      makeNode('3', 'Django', 'framework', [0.2, 0.8, 0]),
    ]
    const edges = [
      makeEdge('1', '2', '用于', 0.9),
      makeEdge('1', '3', '对比', 0.5),
    ]
    const graph = mockGraph(nodes, edges)
    const retriever = new LocalGraphRetriever(graph)

    const result = await retriever.search([1, 0, 0], {
      topK: 5, knowledgeBaseId: 'kb_1',
      relationTypes: ['用于'],
    })

    expect(result.triplets).toHaveLength(1)
    expect(result.triplets[0].relation).toBe('用于')
  })

  it('排除 is_a 关系', async () => {
    const nodes = [
      makeNode('1', 'Python', 'language', [0.9, 0, 0]),
      makeNode('2', 'lang_type', 'entity_type', [0.1, 0.9, 0]),
    ]
    const edges = [
      makeEdge('1', '2', 'is_a', 1),
    ]
    const graph = mockGraph(nodes, edges)
    const retriever = new LocalGraphRetriever(graph)

    const result = await retriever.search([1, 0, 0], {
      topK: 5, knowledgeBaseId: 'kb_1',
    })

    expect(result.triplets).toHaveLength(0) // is_a 被排除
  })

  it('按 weight 排序，最高的在前', async () => {
    const nodes = [
      makeNode('1', 'Python', 'language', [0.9, 0, 0]),
      makeNode('2', 'A', 't', [0.1, 0.9, 0]),
      makeNode('3', 'B', 't', [0.2, 0.8, 0]),
    ]
    const edges = [
      makeEdge('1', '2', 'rel1', 0.9),
      makeEdge('1', '3', 'rel2', 0.3),
    ]
    const graph = mockGraph(nodes, edges)
    const retriever = new LocalGraphRetriever(graph)

    const result = await retriever.search([1, 0, 0], { topK: 5, knowledgeBaseId: 'kb_1' })
    expect(result.triplets[0].weight).toBeGreaterThanOrEqual(result.triplets[1].weight)
  })
})