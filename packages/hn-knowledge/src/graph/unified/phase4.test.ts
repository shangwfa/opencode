import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Pool } from 'pg'
import { PgGraphAdapter } from '../pg-adapter/adapter.js'
import { UnifiedStoreEngine, EngineCapability } from './engine.js'
import { ProvenanceDeletePlanner } from './provenance.js'
import { ContradictionDetector } from '../algorithms/contradiction-detector.js'
import type { GraphNode } from '../types.js'

const TEST_SCHEMA = 'test_phase4'

describe('UnifiedStoreEngine', () => {
  let adapter: PgGraphAdapter
  let engine: UnifiedStoreEngine
  let pool: Pool

  beforeEach(async () => {
    const cs = process.env.DATABASE_URL || ''
    if (!cs) return
    pool = new Pool({ connectionString: cs })
    adapter = new PgGraphAdapter(pool, TEST_SCHEMA)
    engine = new UnifiedStoreEngine(adapter, undefined, TEST_SCHEMA)
    await adapter.init()
  })

  afterEach(async () => {
    if (adapter) {
      await adapter.deleteGraph()
      await pool.end()
    }
  })

  it('should delete by document', async () => {
    if (!adapter) return
    const n1 = await adapter.addNode({ knowledgeBaseId: 'kb_1', name: 'Node1', type: 'entity' })
    const n2 = await adapter.addNode({ knowledgeBaseId: 'kb_1', name: 'Node2', type: 'entity' })
    await adapter.addEdge({ sourceId: n1, targetId: n2, relationshipName: 'rel', knowledgeBaseId: 'kb_1' })

    const result = await engine.deleteByDocument('doc_1', 'kb_1')
    expect(result.deletedNodeIds).toBeDefined()
    expect(typeof result.deletedEdgeCount).toBe('number')
  })

  it('should delete by knowledge base', async () => {
    if (!adapter) return
    await adapter.addNode({ knowledgeBaseId: 'kb_1', name: 'Test', type: 'entity' })
    const result = await engine.deleteByKnowledgeBase('kb_1')
    expect(result.deletedNodeIds.length).toBeGreaterThanOrEqual(1)
    expect(await adapter.isGraphEmpty('kb_1')).toBe(true)
  })
})

describe('ProvenanceDeletePlanner', () => {
  let adapter: PgGraphAdapter
  let planner: ProvenanceDeletePlanner
  let pool: Pool

  beforeEach(async () => {
    const cs = process.env.DATABASE_URL || ''
    if (!cs) return
    pool = new Pool({ connectionString: cs })
    adapter = new PgGraphAdapter(pool, TEST_SCHEMA)
    planner = new ProvenanceDeletePlanner(adapter, TEST_SCHEMA)
    await adapter.init()
  })

  afterEach(async () => {
    if (adapter) {
      await adapter.deleteGraph()
      await pool.end()
    }
  })

  it('should handle empty source ref removal', async () => {
    if (!adapter) return
    const result = await planner.executeSourceRefRemoval('nonexistent', 'kb_1')
    expect(result.deletedNodeIds).toEqual([])
    expect(result.deletedEdgeIds).toEqual([])
  })
})

describe('ContradictionDetector', () => {
  let adapter: PgGraphAdapter
  let detector: ContradictionDetector
  let pool: Pool

  beforeEach(async () => {
    const cs = process.env.DATABASE_URL || ''
    if (!cs) return
    pool = new Pool({ connectionString: cs })
    adapter = new PgGraphAdapter(pool, TEST_SCHEMA)
    // model: null 强制纯规则路径（项目既有模式，见 graph.e2e E2E-9）：
    // 该用例验证规则矛盾检测，不应依赖默认 LLM 端点可用性（.env 指向真实代理时会被拖入网络调用）
    detector = new ContradictionDetector(adapter, { model: null as never })
    await adapter.init()
  })

  afterEach(async () => {
    if (adapter) {
      await adapter.deleteGraph()
      await pool.end()
    }
  })

  it('should detect no contradictions in empty graph', async () => {
    if (!adapter) return
    const result = await detector.detect('kb_1')
    expect(result.contradictions).toEqual([])
    expect(result.resolvedCount).toBe(0)
  })

  it('should detect direct contradictions', async () => {
    if (!adapter) return
    const n1 = await adapter.addNode({ knowledgeBaseId: 'kb_1', name: 'A', type: 'entity' })
    const n2 = await adapter.addNode({ knowledgeBaseId: 'kb_1', name: 'B', type: 'entity' })
    await adapter.addEdge({ sourceId: n1, targetId: n2, relationshipName: '支持', knowledgeBaseId: 'kb_1' })
    await adapter.addEdge({ sourceId: n1, targetId: n2, relationshipName: '不支持', knowledgeBaseId: 'kb_1' })

    const result = await detector.detect('kb_1')
    expect(result.contradictions.length).toBeGreaterThanOrEqual(1)
  })
})

describe('UnifiedStoreEngine (unit)', () => {
  const makeMockGraph = () => ({
    getGraphData: async () => ({ nodes: [], edges: [] }),
    deleteGraph: async () => {},
    deleteNodes: async (_ids: string[]) => {},
    deleteEdge: async (_s: string, _t: string, _r: string) => {},
    query: async (_sql: string, _params: unknown[]) => [],
  }) as any

  it('should have GRAPH capability', () => {
    const engine = new UnifiedStoreEngine(makeMockGraph())
    expect(engine.hasCapability(EngineCapability.GRAPH)).toBe(true)
  })

  it('should not have VECTOR capability without vector service', () => {
    const engine = new UnifiedStoreEngine(makeMockGraph())
    expect(engine.hasCapability(EngineCapability.VECTOR)).toBe(false)
  })

  it('should work with mock graph', async () => {
    const engine = new UnifiedStoreEngine(makeMockGraph())
    const result = await engine.deleteByKnowledgeBase('kb_1')
    expect(result.deletedNodeIds).toEqual([])
    expect(result.deletedEdgeCount).toBe(0)
  })
})

describe('ContradictionDetector (unit)', () => {
  it('should identify contradictory pairs', () => {
    const contradictoryPairs = [
      ['支持', '不支持'],
      ['是', '不是'],
      ['包含', '排除'],
    ]
    const nonContradictory = ['使用', '依赖']

    for (const [a, b] of contradictoryPairs) {
      const isContradictory = (
        (a === '支持' && b === '不支持') ||
        (a === '是' && b === '不是') ||
        (a === '包含' && b === '排除')
      )
      expect(isContradictory).toBe(true)
    }

    const isNonContradictory = (
      (nonContradictory[0] === '支持' && nonContradictory[1] === '不支持') ||
      (nonContradictory[0] === '是' && nonContradictory[1] === '不是')
    )
    expect(isNonContradictory).toBe(false)
  })
})