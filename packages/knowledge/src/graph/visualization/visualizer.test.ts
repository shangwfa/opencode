/**
 * GraphVisualizer 测试（对应 docs/use-cases/graph/graph-visualization.md
 * 与 semantic-memory-map.md 的数据基础验证）
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Pool } from 'pg'
import { PgGraphAdapter } from '../pg-adapter/adapter.js'
import { GraphVisualizer } from './index.js'

const TEST_SCHEMA = 'test_viz'
const KB = 'kb_viz'

describe('GraphVisualizer', () => {
  let adapter: PgGraphAdapter
  let visualizer: GraphVisualizer
  let pool: Pool

  beforeEach(async () => {
    const cs = process.env.DATABASE_URL || ''
    if (!cs) return
    pool = new Pool({ connectionString: cs })
    adapter = new PgGraphAdapter(pool, TEST_SCHEMA, 4)
    visualizer = new GraphVisualizer(adapter)
    await adapter.init()
  })

  afterEach(async () => {
    if (adapter) {
      await adapter.deleteGraph()
      await pool.end()
    }
  })

  it('全图数据：节点/边/统计（full 模式）', async () => {
    if (!adapter) return
    const n1 = await adapter.addNode({ knowledgeBaseId: KB, name: 'Python', type: 'language', frequency: 5 })
    const n2 = await adapter.addNode({ knowledgeBaseId: KB, name: 'FastAPI', type: 'technology' })
    await adapter.addEdge({ sourceId: n1, targetId: n2, relationshipName: '用于', weight: 0.9, knowledgeBaseId: KB })

    const data = await visualizer.getVisualizationData(KB)
    expect(data.nodes).toHaveLength(2)
    expect(data.edges).toHaveLength(1)
    const labels = data.nodes.map((n) => n.label).sort()
    expect(labels).toEqual(['FastAPI', 'Python'])
    const python = data.nodes.find((n) => n.label === 'Python')!
    expect(python.size).toBeGreaterThan(10) // size 按频率放大
    expect(data.edges[0].label).toBe('用于')
    expect(data.edges[0].weight).toBe(0.9)
    expect(data.metadata.nodeCount).toBe(2)
    expect(data.metadata.typeDistribution).toEqual({ language: 1, technology: 1 })
  })

  it('邻域子图：k-hop 有界渲染（种子模式）', async () => {
    if (!adapter) return
    const n1 = await adapter.addNode({ knowledgeBaseId: KB, name: 'n1', type: 'T' })
    const n2 = await adapter.addNode({ knowledgeBaseId: KB, name: 'n2', type: 'T' })
    const n3 = await adapter.addNode({ knowledgeBaseId: KB, name: 'n3', type: 'T' })
    await adapter.addEdge({ sourceId: n1, targetId: n2, relationshipName: 'E', knowledgeBaseId: KB })
    await adapter.addEdge({ sourceId: n2, targetId: n3, relationshipName: 'E', knowledgeBaseId: KB })

    const depth1 = await visualizer.getNeighborhoodViz([n1], 1, KB)
    expect(depth1.nodes.map((n) => n.label).sort()).toEqual(['n1', 'n2'])

    const depth2 = await visualizer.getNeighborhoodViz([n1], 2, KB)
    expect(depth2.nodes).toHaveLength(3)
  })

  it('空图返回空结构', async () => {
    if (!adapter) return
    const data = await visualizer.getVisualizationData(KB)
    expect(data.nodes).toEqual([])
    expect(data.metadata.nodeCount).toBe(0)
  })

  it('语义地图数据基础：节点嵌入可写入并读回', async () => {
    if (!adapter) return
    await adapter.addNode({
      knowledgeBaseId: KB, name: 'Ada Lovelace', type: 'person',
      embedding: [1, 0, 0, 0],
    })
    const data = await visualizer.getVisualizationData(KB)
    // 可视化数据不含 embedding 本体（体积考虑），但底层节点可读取
    const node = await adapter.findNodeByName('Ada Lovelace', KB)
    expect(node!.embedding).toBeDefined()
    expect(node!.embedding![0]).toBeCloseTo(1, 5)
    void data
  })
})