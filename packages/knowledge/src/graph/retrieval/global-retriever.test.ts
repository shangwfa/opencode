import { describe, expect, it, mock } from 'bun:test'
import { GlobalGraphRetriever } from './global-retriever.js'
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
  return {
    supportsCypherQueries: false,
    query: mock(),
    isGraphEmpty: mock(),
    addNode: mock(),
    addNodes: mock(),
    getNode: mock(),
    getNodes: mock(),
    deleteNode: mock(),
    deleteNodes: mock(),
    updateNode: mock(),
    findNodeByName: mock(),
    findNodesByType: mock(),
    addEdge: mock(),
    addEdges: mock(),
    getEdges: mock(),
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
  } as unknown as GraphDB
}

describe('GlobalGraphRetriever', () => {
  it('按 embedding 相似度 + weight 排序检索三元组', async () => {
    const nodes = [
      makeNode('1', 'Python', 'language', [0.9, 0.1, 0]),
      makeNode('2', 'FastAPI', 'framework', [0.1, 0.9, 0.1]),
      makeNode('3', 'TypeScript', 'language', [0.2, 0.3, 0.9]),
    ]
    const edges = [
      makeEdge('1', '2', '用于', 0.9),
      makeEdge('1', '3', '对比', 0.5),
    ]
    const graph = mockGraph(nodes, edges)
    const retriever = new GlobalGraphRetriever(graph)

    // 查询偏向 Python → "用于" 应排在 "对比" 前面
    const result = await retriever.search([1, 0, 0], { topK: 5, knowledgeBaseId: 'kb_1' })

    expect(result.triplets.length).toBe(2)
    expect(result.triplets[0].relation).toBe('用于')
    expect(result.triplets[1].relation).toBe('对比')
  })

  it('空图返回空结果', async () => {
    const graph = mockGraph([], [])
    const retriever = new GlobalGraphRetriever(graph)
    const result = await retriever.search([1, 0, 0], { topK: 5, knowledgeBaseId: 'kb_1' })
    expect(result.triplets).toEqual([])
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
    const retriever = new GlobalGraphRetriever(graph)

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
    const retriever = new GlobalGraphRetriever(graph)

    const result = await retriever.search([1, 0, 0], {
      topK: 5, knowledgeBaseId: 'kb_1',
    })
    expect(result.triplets).toHaveLength(0)
  })

  it('minWeight 过滤低权重关系', async () => {
    const nodes = [
      makeNode('1', 'Python', 'language', [0.9, 0, 0]),
      makeNode('2', 'FastAPI', 'framework', [0.1, 0.9, 0]),
    ]
    const edges = [
      makeEdge('1', '2', '用于', 0.3),
    ]
    const graph = mockGraph(nodes, edges)
    const retriever = new GlobalGraphRetriever(graph)

    const result = await retriever.search([1, 0, 0], {
      topK: 5, knowledgeBaseId: 'kb_1', minWeight: 0.5,
    })
    expect(result.triplets).toHaveLength(0)
  })

  it('topK 限制返回数量', async () => {
    const nodes = [
      makeNode('1', 'A', 't', [0.9, 0, 0]),
      makeNode('2', 'B', 't', [0.1, 0.9, 0]),
      makeNode('3', 'C', 't', [0.2, 0.8, 0]),
    ]
    const edges = [
      makeEdge('1', '2', 'r1', 0.5),
      makeEdge('1', '3', 'r2', 0.5),
    ]
    const graph = mockGraph(nodes, edges)
    const retriever = new GlobalGraphRetriever(graph)

    const result = await retriever.search([1, 0, 0], {
      topK: 1, knowledgeBaseId: 'kb_1',
    })
    expect(result.triplets).toHaveLength(1)
  })
})