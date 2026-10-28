import { describe, expect, it } from 'bun:test'
import { CogneeGraph } from './cognee-graph.js'
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

function makeEdge(sourceId: string, targetId: string, rel: string, weight = 1): GraphEdge {
  return {
    sourceId,
    targetId,
    relationshipName: rel,
    properties: {},
    weight,
    knowledgeBaseId: 'kb_1',
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}

describe('CogneeGraph', () => {
  it('should add nodes and edges', () => {
    const g = new CogneeGraph()
    const n1 = makeNode('1', 'Python')
    const n2 = makeNode('2', 'TypeScript')
    g.addNode(n1)
    g.addNode(n2)
    g.addEdge(makeEdge('1', '2', 'similar', 0.8))

    expect(g.nodes.size).toBe(2)
    expect(g.edges.length).toBe(1)
    expect(g.getNode('1')).toBeDefined()
    expect(g.getNode('2')).toBeDefined()
  })

  it('should not duplicate nodes', () => {
    const g = new CogneeGraph()
    g.addNode(makeNode('1', 'Python'))
    g.addNode(makeNode('1', 'Python'))
    expect(g.nodes.size).toBe(1)
  })

  it('should get neighbors', () => {
    const g = new CogneeGraph()
    const n1 = makeNode('1', 'Center')
    const n2 = makeNode('2', 'Leaf')
    g.addNode(n1)
    g.addNode(n2)
    g.addEdge(makeEdge('1', '2', 'connects'))

    const neighbors = g.getNeighbors('1')
    expect(neighbors.length).toBe(1)
    expect(neighbors[0].id).toBe('2')
  })

  it('should get edges for a node', () => {
    const g = new CogneeGraph()
    g.addNode(makeNode('1', 'A'))
    g.addNode(makeNode('2', 'B'))
    g.addNode(makeNode('3', 'C'))
    g.addEdge(makeEdge('1', '2', 'rel1'))
    g.addEdge(makeEdge('1', '3', 'rel2'))

    const edges = g.getEdges('1')
    expect(edges.length).toBe(2)
  })

  it('should calculate top triplet importances', () => {
    const g = new CogneeGraph()
    const n1 = makeNode('1', 'Python', 'language')
    const n2 = makeNode('2', 'FastAPI', 'framework')
    const n3 = makeNode('3', 'React', 'framework')
    const n4 = makeNode('4', 'TypeScript', 'language')

    g.addNode(n1)
    g.addNode(n2)
    g.addNode(n3)
    g.addNode(n4)

    g.addEdge(makeEdge('1', '2', 'used_by', 0.9))
    g.addEdge(makeEdge('1', '4', 'similar', 0.8))
    g.addEdge(makeEdge('3', '4', 'used_by', 0.7))

    const triplets = g.calculateTopTripletImportances(2, {
      alpha: 0.4,
      beta: 0.3,
      gamma: 0.2,
      delta: 0.1,
    } as any)
    expect(triplets.length).toBe(2)
    expect(triplets[0].relation).toBeTruthy()
    expect(triplets[0].source.name).toBeTruthy()
    expect(triplets[0].target.name).toBeTruthy()
  })

  it('should map vector distances to nodes', () => {
    const g = new CogneeGraph()
    g.addNode(makeNode('1', 'Python'))
    g.addNode(makeNode('2', 'TypeScript'))

    const queryEmb = [1, 0, 0]
    const embeddings = new Map<string, number[]>([
      ['1', [0.9, 0.1, 0.1]],
      ['2', [0.1, 0.9, 0.1]],
    ])

    g.mapVectorDistancesToNodes(queryEmb, embeddings)
    expect(g.getNode('1')!.distance).toBeLessThan(g.getNode('2')!.distance)
  })

  it('should apply personal weights', () => {
    const g = new CogneeGraph()
    g.addNode(makeNode('1', 'Python'))
    g.addNode(makeNode('2', 'TypeScript'))

    const weights = new Map<string, number>([['1', 0.9], ['2', 0.1]])
    g.applyPersonalWeights(weights)
    expect(g.getNode('1')!.personalWeight).toBe(0.9)
    expect(g.getNode('2')!.personalWeight).toBe(0.1)
  })
})