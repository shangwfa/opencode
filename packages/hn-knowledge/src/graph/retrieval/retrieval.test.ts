import { describe, expect, it } from 'bun:test'
import { CogneeGraph } from '../knowledge-graph/cognee-graph.js'
import type { GraphNode, GraphEdge } from '../types.js'

function makeNode(id: string, name: string, type = 'entity'): GraphNode {
  return {
    id,
    knowledgeBaseId: 'kb_1',
    name,
    type,
    properties: {},
    frequency: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}

function makeEdge(s: string, t: string, rel: string, w = 1): GraphEdge {
  return {
    sourceId: s, targetId: t, relationshipName: rel,
    properties: {}, weight: w, knowledgeBaseId: 'kb_1',
    createdAt: new Date(), updatedAt: new Date(),
  }
}

describe('GraphCompletionRetriever (unit)', () => {
  it('should score triplets by vector distance', () => {
    const g = new CogneeGraph()
    const n1 = makeNode('1', 'Python', 'language')
    const n2 = makeNode('2', 'FastAPI', 'framework')
    const n3 = makeNode('3', 'React', 'framework')
    g.addNode(n1); g.addNode(n2); g.addNode(n3)
    g.addEdge(makeEdge('1', '2', '用于', 0.9))
    g.addEdge(makeEdge('1', '3', '对比', 0.5))

    const queryEmb = [1, 0, 0]
    const embeddings = new Map([
      ['1', [0.9, 0.1, 0]],
      ['2', [0.1, 0.8, 0.1]],
      ['3', [0.2, 0.7, 0.2]],
    ])
    g.mapVectorDistancesToNodes(queryEmb, embeddings)
    g.mapVectorDistancesToEdges(queryEmb, embeddings)
    const triplets = g.calculateTopTripletImportances(2, {
      alpha: 0.6, beta: 0.2, gamma: 0.1, delta: 0.1,
    } as any)
    expect(triplets.length).toBe(2)
    // 距离空间（对标 cognee）：score 越小越重要 → 升序
    expect(triplets[0].score).toBeLessThanOrEqual(triplets[1].score)
  })

  it('should return empty for empty graph', () => {
    const g = new CogneeGraph()
    const triplets = g.calculateTopTripletImportances(10)
    expect(triplets).toEqual([])
  })

  it('should incorporate personal weights', () => {
    const g = new CogneeGraph()
    const n1 = makeNode('1', 'A', 'concept')
    const n2 = makeNode('2', 'B', 'concept')
    g.addNode(n1); g.addNode(n2)
    g.addEdge(makeEdge('1', '2', '关联', 0.5))

    g.applyPersonalWeights(new Map([['1', 0.9], ['2', 0.1]]))
    expect(g.getNode('1')!.personalWeight).toBe(0.9)
    expect(g.getNode('2')!.personalWeight).toBe(0.1)
  })
})

describe('HybridGraphRetriever (unit)', () => {
  it('should format triplets as search results', () => {
    const g = new CogneeGraph()
    const n1 = makeNode('1', 'Python', 'language')
    const n2 = makeNode('2', 'FastAPI', 'framework')
    g.addNode(n1); g.addNode(n2)
    g.addEdge(makeEdge('1', '2', '用于', 0.9))

    const queryEmb = [1, 0, 0]
    const embeddings = new Map([['1', [0.9, 0.1, 0]], ['2', [0.1, 0.8, 0.1]]])
    g.mapVectorDistancesToNodes(queryEmb, embeddings)
    const triplets = g.calculateTopTripletImportances(1)

    expect(triplets.length).toBe(1)
    expect(triplets[0].source.name).toBe('Python')
    expect(triplets[0].target.name).toBe('FastAPI')
    expect(triplets[0].relation).toBe('用于')
  })
})