import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Pool } from 'pg'
import { PgGraphAdapter } from './adapter.js'
import type { GraphNode, GraphEdge } from '../types.js'

const TEST_SCHEMA = 'test_graph_unit'

describe.skipIf(!process.env.DATABASE_URL)('PgGraphAdapter', () => {
  let adapter: PgGraphAdapter
  let pool: Pool

  beforeEach(async () => {
    const connectionString = process.env.DATABASE_URL || ''
    if (!connectionString) {
      throw new Error('DATABASE_URL is required for tests')
    }
    pool = new Pool({ connectionString })
    adapter = new PgGraphAdapter(pool, TEST_SCHEMA)
    await adapter.init()
  })

  afterEach(async () => {
    await adapter.deleteGraph()
    await pool.end()
  })

  describe('node operations', () => {
    it('should add a node and return its id', async () => {
      const id = await adapter.addNode({
        knowledgeBaseId: 'kb_1',
        name: 'Python',
        type: 'language',
        properties: { version: '3.12' },
      })
      expect(id).toBeTruthy()
      expect(typeof id).toBe('string')
    })

    it('should get a node by id', async () => {
      const id = await adapter.addNode({
        knowledgeBaseId: 'kb_1',
        name: 'TypeScript',
        type: 'language',
      })
      const node = await adapter.getNode(id)
      expect(node).not.toBeNull()
      expect(node!.name).toBe('TypeScript')
      expect(node!.type).toBe('language')
      expect(node!.knowledgeBaseId).toBe('kb_1')
    })

    it('should return null for non-existent node', async () => {
      const node = await adapter.getNode('00000000-0000-0000-0000-000000000000')
      expect(node).toBeNull()
    })

    it('should update a node', async () => {
      const id = await adapter.addNode({
        knowledgeBaseId: 'kb_1',
        name: 'Node.js',
        type: 'runtime',
      })
      await adapter.updateNode(id, { type: 'platform', properties: { version: '20' } })
      const node = await adapter.getNode(id)
      expect(node!.type).toBe('platform')
      expect(node!.properties).toEqual({ version: '20' })
    })

    it('should find node by name', async () => {
      await adapter.addNode({ knowledgeBaseId: 'kb_1', name: 'React', type: 'framework' })
      const node = await adapter.findNodeByName('React', 'kb_1')
      expect(node).not.toBeNull()
      expect(node!.name).toBe('React')
    })

    it('should find nodes by type', async () => {
      await adapter.addNode({ knowledgeBaseId: 'kb_1', name: 'Vue', type: 'framework' })
      await adapter.addNode({ knowledgeBaseId: 'kb_1', name: 'React', type: 'framework' })
      await adapter.addNode({ knowledgeBaseId: 'kb_1', name: 'Python', type: 'language' })
      const frameworks = await adapter.findNodesByType('framework', 'kb_1')
      expect(frameworks.length).toBe(2)
    })

    it('should delete a node', async () => {
      const id = await adapter.addNode({ knowledgeBaseId: 'kb_1', name: 'Tmp', type: 'test' })
      await adapter.deleteNode(id)
      const node = await adapter.getNode(id)
      expect(node).toBeNull()
    })

    it('should upsert node by name on conflict', async () => {
      const id1 = await adapter.addNode({
        knowledgeBaseId: 'kb_1',
        name: 'UniqueName',
        type: 'test',
        properties: { a: 1 },
      })
      const id2 = await adapter.addNode({
        knowledgeBaseId: 'kb_1',
        name: 'UniqueName',
        type: 'test',
        properties: { b: 2 },
      })
      const node = await adapter.getNode(id1)
      expect(node!.properties).toMatchObject({ a: 1, b: 2 })
      expect(node!.frequency).toBeGreaterThanOrEqual(2)
    })
  })

  describe('edge operations', () => {
    it('should add and retrieve edges', async () => {
      const n1 = await adapter.addNode({ knowledgeBaseId: 'kb_1', name: 'Docker', type: 'tool' })
      const n2 = await adapter.addNode({ knowledgeBaseId: 'kb_1', name: 'Kubernetes', type: 'tool' })

      await adapter.addEdge({
        sourceId: n1,
        targetId: n2,
        relationshipName: 'orchestrates',
        knowledgeBaseId: 'kb_1',
        weight: 0.9,
      })

      const edges = await adapter.getEdges(n1)
      expect(edges.length).toBe(1)
      expect(edges[0].relationshipName).toBe('orchestrates')
      expect(edges[0].weight).toBe(0.9)
    })

    it('should check edge existence', async () => {
      const n1 = await adapter.addNode({ knowledgeBaseId: 'kb_1', name: 'A', type: 'test' })
      const n2 = await adapter.addNode({ knowledgeBaseId: 'kb_1', name: 'B', type: 'test' })

      await adapter.addEdge({ sourceId: n1, targetId: n2, relationshipName: 'connects', knowledgeBaseId: 'kb_1' })
      expect(await adapter.hasEdge(n1, n2, 'connects')).toBe(true)
      expect(await adapter.hasEdge(n1, n2, 'disconnects')).toBe(false)
    })

    it('should delete an edge', async () => {
      const n1 = await adapter.addNode({ knowledgeBaseId: 'kb_1', name: 'X', type: 'test' })
      const n2 = await adapter.addNode({ knowledgeBaseId: 'kb_1', name: 'Y', type: 'test' })

      await adapter.addEdge({ sourceId: n1, targetId: n2, relationshipName: 'links', knowledgeBaseId: 'kb_1' })
      await adapter.deleteEdge(n1, n2, 'links')
      expect(await adapter.hasEdge(n1, n2, 'links')).toBe(false)
    })
  })

  describe('graph traversal', () => {
    it('should get neighbors', async () => {
      const n1 = await adapter.addNode({ knowledgeBaseId: 'kb_1', name: 'Center', type: 'test' })
      const n2 = await adapter.addNode({ knowledgeBaseId: 'kb_1', name: 'Leaf1', type: 'test' })
      const n3 = await adapter.addNode({ knowledgeBaseId: 'kb_1', name: 'Leaf2', type: 'test' })

      await adapter.addEdge({ sourceId: n1, targetId: n2, relationshipName: 'to', knowledgeBaseId: 'kb_1' })
      await adapter.addEdge({ sourceId: n1, targetId: n3, relationshipName: 'to', knowledgeBaseId: 'kb_1' })

      const neighbors = await adapter.getNeighbors(n1)
      expect(neighbors.length).toBe(2)
    })

    it('should traverse k-hop neighborhood', async () => {
      const n1 = await adapter.addNode({ knowledgeBaseId: 'kb_1', name: 'Root', type: 'test' })
      const n2 = await adapter.addNode({ knowledgeBaseId: 'kb_1', name: 'Child', type: 'test' })
      const n3 = await adapter.addNode({ knowledgeBaseId: 'kb_1', name: 'Grandchild', type: 'test' })

      await adapter.addEdge({ sourceId: n1, targetId: n2, relationshipName: 'parent', knowledgeBaseId: 'kb_1' })
      await adapter.addEdge({ sourceId: n2, targetId: n3, relationshipName: 'parent', knowledgeBaseId: 'kb_1' })

      const subgraph = await adapter.getNeighborhood({ seedIds: [n1], maxDepth: 2 })
      expect(subgraph.nodes.length).toBe(3)
      expect(subgraph.edges.length).toBe(2)
    })

    it('should filter neighborhood by edge types', async () => {
      const n1 = await adapter.addNode({ knowledgeBaseId: 'kb_1', name: 'Root', type: 'test' })
      const n2 = await adapter.addNode({ knowledgeBaseId: 'kb_1', name: 'A', type: 'test' })
      const n3 = await adapter.addNode({ knowledgeBaseId: 'kb_1', name: 'B', type: 'test' })

      await adapter.addEdge({ sourceId: n1, targetId: n2, relationshipName: 'friend', knowledgeBaseId: 'kb_1' })
      await adapter.addEdge({ sourceId: n1, targetId: n3, relationshipName: 'enemy', knowledgeBaseId: 'kb_1' })

      const subgraph = await adapter.getNeighborhood({
        seedIds: [n1],
        maxDepth: 1,
        edgeTypes: ['friend'],
      })
      expect(subgraph.nodes.length).toBe(2)
      expect(subgraph.edges.length).toBe(1)
    })
  })

  describe('graph metrics', () => {
    it('should compute basic metrics', async () => {
      const n1 = await adapter.addNode({ knowledgeBaseId: 'kb_1', name: 'A', type: 'type1' })
      const n2 = await adapter.addNode({ knowledgeBaseId: 'kb_1', name: 'B', type: 'type1' })
      const n3 = await adapter.addNode({ knowledgeBaseId: 'kb_1', name: 'C', type: 'type2' })

      await adapter.addEdge({ sourceId: n1, targetId: n2, relationshipName: 'rel1', knowledgeBaseId: 'kb_1' })
      await adapter.addEdge({ sourceId: n2, targetId: n3, relationshipName: 'rel2', knowledgeBaseId: 'kb_1' })

      const metrics = await adapter.getGraphMetrics('kb_1')
      expect(metrics.nodeCount).toBe(3)
      expect(metrics.edgeCount).toBe(2)
      expect(metrics.nodeTypeDistribution).toMatchObject({ type1: 2, type2: 1 })
      expect(metrics.relationshipDistribution).toMatchObject({ rel1: 1, rel2: 1 })
      expect(metrics.density).toBeGreaterThan(0)
      expect(metrics.avgDegree).toBeGreaterThan(0)
    })
  })

  describe('graph data', () => {
    it('should get all graph data', async () => {
      const n1 = await adapter.addNode({ knowledgeBaseId: 'kb_1', name: 'N1', type: 'test' })
      const n2 = await adapter.addNode({ knowledgeBaseId: 'kb_1', name: 'N2', type: 'test' })
      await adapter.addEdge({ sourceId: n1, targetId: n2, relationshipName: 'rel', knowledgeBaseId: 'kb_1' })

      const data = await adapter.getGraphData('kb_1')
      expect(data.nodes.length).toBe(2)
      expect(data.edges.length).toBe(1)
    })

    it('should filter graph data by attributes', async () => {
      await adapter.addNode({ knowledgeBaseId: 'kb_1', name: 'WithProp', type: 'test', properties: { env: 'prod' } })
      await adapter.addNode({ knowledgeBaseId: 'kb_1', name: 'WithoutProp', type: 'test' })

      const data = await adapter.getFilteredGraphData({ env: 'prod' }, 'kb_1')
      expect(data.nodes.length).toBe(1)
      expect(data.nodes[0].name).toBe('WithProp')
    })
  })

  describe('isGraphEmpty', () => {
    it('should return true for empty graph', async () => {
      expect(await adapter.isGraphEmpty('kb_empty')).toBe(true)
    })

    it('should return false for non-empty graph', async () => {
      await adapter.addNode({ knowledgeBaseId: 'kb_1', name: 'Something', type: 'test' })
      expect(await adapter.isGraphEmpty('kb_1')).toBe(false)
    })
  })
})
