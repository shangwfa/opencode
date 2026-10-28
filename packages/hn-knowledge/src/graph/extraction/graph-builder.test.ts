import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Pool } from 'pg'
import { PgGraphAdapter } from '../pg-adapter/adapter.js'
import { GraphBuilder } from './graph-builder.js'
import type { CombinedExtraction } from '../types.js'

const TEST_SCHEMA = 'test_graph_builder'

describe('GraphBuilder', () => {
  let adapter: PgGraphAdapter
  let builder: GraphBuilder
  let pool: Pool

  beforeEach(async () => {
    const connectionString = process.env.DATABASE_URL || ''
    if (!connectionString) return
    pool = new Pool({ connectionString })
    adapter = new PgGraphAdapter(pool, TEST_SCHEMA)
    builder = new GraphBuilder(adapter)
    await adapter.init()
  })

  afterEach(async () => {
    if (adapter) {
      await adapter.deleteGraph()
      await pool.end()
    }
  })

  const extraction: CombinedExtraction = {
    entities: [
      { name: 'Python', type: 'language', description: '编程语言' },
      { name: 'FastAPI', type: 'technology', description: 'Web框架' },
      { name: 'PostgreSQL', type: 'technology', description: '数据库' },
    ],
    triplets: [
      { source: 'Python', relation: '用于', target: 'FastAPI', confidence: 0.9 },
      { source: 'FastAPI', relation: '连接', target: 'PostgreSQL', confidence: 0.8 },
    ],
  }

  it('should build graph from extraction', async () => {
    if (!adapter) return

    const result = await builder.buildFromExtraction(extraction, {
      knowledgeBaseId: 'kb_test',
    })

    expect(result.nodeIds.length).toBe(3)
    expect(result.edgeCount).toBe(2)

    const node1 = await adapter.findNodeByName('Python', 'kb_test')
    expect(node1).not.toBeNull()
    expect(node1!.type).toBe('language')

    const node2 = await adapter.findNodeByName('FastAPI', 'kb_test')
    expect(node2).not.toBeNull()
    expect(node2!.type).toBe('technology')
  })

  it('should skip low-confidence triplets', async () => {
    if (!adapter) return

    const lowConfExtraction: CombinedExtraction = {
      entities: [
        { name: 'A', type: 'concept' },
        { name: 'B', type: 'concept' },
      ],
      triplets: [
        { source: 'A', relation: '关联', target: 'B', confidence: 0.2 },
      ],
    }

    const result = await builder.buildFromExtraction(lowConfExtraction, {
      knowledgeBaseId: 'kb_test',
    })

    expect(result.nodeIds.length).toBe(2)
    expect(result.edgeCount).toBe(0)
  })

  it('should handle empty extraction', async () => {
    if (!adapter) return

    const result = await builder.buildFromExtraction(
      { entities: [], triplets: [] },
      { knowledgeBaseId: 'kb_test' }
    )

    expect(result.nodeIds.length).toBe(0)
    expect(result.edgeCount).toBe(0)
  })

  it('should skip triplets with missing entities', async () => {
    if (!adapter) return

    const partialExtraction: CombinedExtraction = {
      entities: [
        { name: 'X', type: 'concept' },
      ],
      triplets: [
        { source: 'X', relation: '关联', target: 'Y', confidence: 0.9 },
      ],
    }

    const result = await builder.buildFromExtraction(partialExtraction, {
      knowledgeBaseId: 'kb_test',
    })

    expect(result.nodeIds.length).toBe(1)
    expect(result.edgeCount).toBe(0)
  })
})

describe('GraphBuilder (unit)', () => {
  it('should work with mock graph', async () => {
    const mockNodes: string[] = []
    const mockGraph = {
      addNodes: async (inputs: any[]) => {
        const ids = inputs.map(() => crypto.randomUUID())
        mockNodes.push(...ids)
        return ids
      },
      addEdges: async (_inputs: any[]) => {},
    } as any

    const builder = new GraphBuilder(mockGraph)
    const result = await builder.buildFromExtraction(
      {
        entities: [
          { name: 'A', type: 'concept' },
          { name: 'B', type: 'concept' },
        ],
        triplets: [
          { source: 'A', relation: '关联', target: 'B', confidence: 0.9 },
        ],
      },
      { knowledgeBaseId: 'kb_test' }
    )

    expect(result.nodeIds.length).toBe(2)
    expect(result.edgeCount).toBe(1)
  })
})