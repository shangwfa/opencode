/**
 * 适配器行为契约测试（移植自 cognee/tests/e2e/turso/test_turso_adapter.py 契约集）
 * 在本地 PostgreSQL 上验证 PgGraphAdapter 的行为契约。
 *
 * 另含：
 * - cognee/tests/unit/infrastructure/databases/graph/test_triplets_batch_pagination.py（分页不变量）
 * - cognee/tests/unit/modules/retrieval/hybrid/test_personal_weight_ranking.py（权重 no-op 语义，见文末）
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Pool } from 'pg'
import { PgGraphAdapter } from '../pg-adapter/adapter.js'
import { CogneeGraph } from '../knowledge-graph/cognee-graph.js'
import type { GraphNode, GraphEdge } from '../types.js'

const TEST_SCHEMA = 'test_contract'
const KB = 'kb_contract'

describe('移植: PgGraphAdapter 行为契约（Turso 契约集）', () => {
  let adapter: PgGraphAdapter
  let pool: Pool

  beforeEach(async () => {
    const cs = process.env.DATABASE_URL || ''
    if (!cs) return
    pool = new Pool({ connectionString: cs })
    adapter = new PgGraphAdapter(pool, TEST_SCHEMA, 4)
    await adapter.init()
  })

  afterEach(async () => {
    if (adapter) {
      await adapter.deleteGraph()
      await pool.end()
    }
  })

  it('新库 isGraphEmpty 为 true', async () => {
    if (!adapter) return
    expect(await adapter.isGraphEmpty(KB)).toBe(true)
  })

  it('addNode + getNode：name/type 正确读取', async () => {
    if (!adapter) return
    const id = await adapter.addNode({ knowledgeBaseId: KB, name: 'Alice', type: 'Person' })
    const node = await adapter.getNode(id)
    expect(node!.name).toBe('Alice')
    expect(node!.type).toBe('Person')
  })

  it('addNodes 批量写入，getNodes 返回全部', async () => {
    if (!adapter) return
    const ids = await adapter.addNodes([
      { knowledgeBaseId: KB, name: 'N1', type: 'T' },
      { knowledgeBaseId: KB, name: 'N2', type: 'T' },
      { knowledgeBaseId: KB, name: 'N3', type: 'T' },
    ])
    const nodes = await adapter.getNodes(ids)
    expect(nodes).toHaveLength(3)
  })

  it('节点 upsert：同 (kb, name) 重写更新（按名称取回）', async () => {
    if (!adapter) return
    const id1 = await adapter.addNode({ knowledgeBaseId: KB, name: 'Alice', type: 'Person', properties: { v: 1 } })
    await adapter.addNode({ knowledgeBaseId: KB, name: 'Alice', type: 'Person', properties: { v: 2 } })
    // upsert 更新已存在行（保留原 id），按名称取回
    const node = await adapter.findNodeByName('Alice', KB)
    expect(node).not.toBeNull()
    expect(node!.id).toBe(id1)
    // jsonb 合并语义：后者覆盖同键
    expect(node!.properties.v).toBe(2)
  })

  it('deleteNode 后 getNode 返回 null', async () => {
    if (!adapter) return
    const id = await adapter.addNode({ knowledgeBaseId: KB, name: 'Temp', type: 'T' })
    await adapter.deleteNode(id)
    expect(await adapter.getNode(id)).toBeNull()
  })

  it('has_edge 有方向性', async () => {
    if (!adapter) return
    const n1 = await adapter.addNode({ knowledgeBaseId: KB, name: 'A', type: 'T' })
    const n2 = await adapter.addNode({ knowledgeBaseId: KB, name: 'B', type: 'T' })
    await adapter.addEdge({ sourceId: n1, targetId: n2, relationshipName: 'KNOWS', knowledgeBaseId: KB })
    expect(await adapter.hasEdge(n1, n2, 'KNOWS')).toBe(true)
    expect(await adapter.hasEdge(n2, n1, 'KNOWS')).toBe(false)
  })

  it('hasEdges 只返回存在的元组', async () => {
    if (!adapter) return
    const n1 = await adapter.addNode({ knowledgeBaseId: KB, name: 'A', type: 'T' })
    const n2 = await adapter.addNode({ knowledgeBaseId: KB, name: 'B', type: 'T' })
    const n3 = await adapter.addNode({ knowledgeBaseId: KB, name: 'C', type: 'T' })
    await adapter.addEdge({ sourceId: n1, targetId: n2, relationshipName: 'KNOWS', knowledgeBaseId: KB })

    const missing = await adapter.hasEdges([
      { sourceId: n1, targetId: n2, relationshipName: 'KNOWS' }, // 存在
      { sourceId: n1, targetId: n3, relationshipName: 'KNOWS' }, // 不存在
      { sourceId: n2, targetId: n3, relationshipName: 'KNOWS' }, // 不存在
    ])
    expect(missing).toHaveLength(2)
    expect(missing.every((e) => e.targetId === n3)).toBe(true)
  })

  it('getNeighbors 返回邻居集合（去重）', async () => {
    if (!adapter) return
    const n1 = await adapter.addNode({ knowledgeBaseId: KB, name: 'Center', type: 'T' })
    const n2 = await adapter.addNode({ knowledgeBaseId: KB, name: 'N2', type: 'T' })
    const n3 = await adapter.addNode({ knowledgeBaseId: KB, name: 'N3', type: 'T' })
    await adapter.addEdge({ sourceId: n1, targetId: n2, relationshipName: 'KNOWS', knowledgeBaseId: KB })
    await adapter.addEdge({ sourceId: n3, targetId: n1, relationshipName: 'KNOWS', knowledgeBaseId: KB })

    const neighbors = await adapter.getNeighbors(n1)
    const ids = neighbors.map((nb) => nb.node.id)
    expect(ids).toHaveLength(2) // n2 + n3，无重复
    expect(ids).toContain(n2)
    expect(ids).toContain(n3)
  })

  it('getGraphMetrics 含连通分量/平均度/密度', async () => {
    if (!adapter) return
    const n1 = await adapter.addNode({ knowledgeBaseId: KB, name: 'A', type: 'T' })
    const n2 = await adapter.addNode({ knowledgeBaseId: KB, name: 'B', type: 'T' })
    await adapter.addEdge({ sourceId: n1, targetId: n2, relationshipName: 'KNOWS', knowledgeBaseId: KB })

    const m = await adapter.getGraphMetrics(KB)
    expect(m.nodeCount).toBe(2)
    expect(m.edgeCount).toBe(1)
    expect(m.connectedComponents).toBe(1) // 此前硬编码 0，契约要求真实计算
    expect(m.avgDegree).toBe(1)
    expect(m.density).toBe(1) // 2 节点 1 边（无向）密度 = 1
  })

  it('getGraphMetrics 多分量场景', async () => {
    if (!adapter) return
    const ids = await adapter.addNodes(
      ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => ({ knowledgeBaseId: KB, name: n, type: 'T' }))
    )
    await adapter.addEdges([
      { sourceId: ids[0], targetId: ids[1], relationshipName: 'E', knowledgeBaseId: KB },
      { sourceId: ids[1], targetId: ids[2], relationshipName: 'E', knowledgeBaseId: KB },
      { sourceId: ids[3], targetId: ids[4], relationshipName: 'E', knowledgeBaseId: KB },
      // ids[5] 孤立
    ])
    const m = await adapter.getGraphMetrics(KB)
    expect(m.nodeCount).toBe(6)
    expect(m.connectedComponents).toBe(3)
  })

  it('deleteGraph 后 isGraphEmpty 为 true', async () => {
    if (!adapter) return
    await adapter.addNode({ knowledgeBaseId: KB, name: 'X', type: 'T' })
    await adapter.deleteGraph(KB)
    expect(await adapter.isGraphEmpty(KB)).toBe(true)
  })

  it('getNeighborhood depth 过滤：depth=1 不含二跳', async () => {
    if (!adapter) return
    const n1 = await adapter.addNode({ knowledgeBaseId: KB, name: 'n1', type: 'T' })
    const n2 = await adapter.addNode({ knowledgeBaseId: KB, name: 'n2', type: 'T' })
    const n3 = await adapter.addNode({ knowledgeBaseId: KB, name: 'n3', type: 'T' })
    await adapter.addEdge({ sourceId: n1, targetId: n2, relationshipName: 'KNOWS', knowledgeBaseId: KB })
    await adapter.addEdge({ sourceId: n2, targetId: n3, relationshipName: 'KNOWS', knowledgeBaseId: KB })

    const depth1 = await adapter.getNeighborhood({ seedIds: [n1], maxDepth: 1 })
    expect(depth1.nodes.map((n) => n.id).sort()).toEqual([n1, n2].sort())

    const depth2 = await adapter.getNeighborhood({ seedIds: [n1], maxDepth: 2 })
    expect(depth2.nodes).toHaveLength(3)
  })

  it('getNeighborhood 边类型过滤', async () => {
    if (!adapter) return
    const n1 = await adapter.addNode({ knowledgeBaseId: KB, name: 'n1', type: 'T' })
    const n2 = await adapter.addNode({ knowledgeBaseId: KB, name: 'n2', type: 'T' })
    const n3 = await adapter.addNode({ knowledgeBaseId: KB, name: 'n3', type: 'T' })
    await adapter.addEdge({ sourceId: n1, targetId: n2, relationshipName: 'KNOWS', knowledgeBaseId: KB })
    await adapter.addEdge({ sourceId: n1, targetId: n3, relationshipName: 'DISLIKES', knowledgeBaseId: KB })

    const onlyKnows = await adapter.getNeighborhood({ seedIds: [n1], maxDepth: 1, edgeTypes: ['KNOWS'] })
    expect(onlyKnows.nodes.map((n) => n.id).sort()).toEqual([n1, n2].sort())
  })

  it('级联删除：删节点后对端 getEdges 为空', async () => {
    if (!adapter) return
    const n1 = await adapter.addNode({ knowledgeBaseId: KB, name: 'A', type: 'T' })
    const n2 = await adapter.addNode({ knowledgeBaseId: KB, name: 'B', type: 'T' })
    await adapter.addEdge({ sourceId: n1, targetId: n2, relationshipName: 'KNOWS', knowledgeBaseId: KB })

    await adapter.deleteNode(n1)
    expect(await adapter.getEdges(n2)).toHaveLength(0)
  })

  it('节点 upsert 不级联删边（重写保留边）', async () => {
    if (!adapter) return
    const n1 = await adapter.addNode({ knowledgeBaseId: KB, name: 'A', type: 'T' })
    const n2 = await adapter.addNode({ knowledgeBaseId: KB, name: 'B', type: 'T' })
    await adapter.addEdge({ sourceId: n1, targetId: n2, relationshipName: 'KNOWS', knowledgeBaseId: KB })

    // 重写 A（upsert 语义）
    await adapter.addNode({ knowledgeBaseId: KB, name: 'A', type: 'T', properties: { v: 2 } })
    expect(await adapter.hasEdge(n1, n2, 'KNOWS')).toBe(true)
  })

  it('getFilteredGraphData 空结果不报错', async () => {
    if (!adapter) return
    await adapter.addNode({ knowledgeBaseId: KB, name: 'A', type: 'T' })
    const data = await adapter.getFilteredGraphData({ nonexistent: 'x' }, KB)
    expect(data.nodes).toHaveLength(0)
    expect(data.edges).toHaveLength(0)
  })

  it('getSubgraphByNodeSetLabel 空 names 返回空', async () => {
    if (!adapter) return
    await adapter.addNode({ knowledgeBaseId: KB, name: 'A', type: 'T' })
    const sub = await (adapter as any).getSubgraphByNodeSetLabel('no_such_set', KB)
    expect(sub.nodes).toHaveLength(0)
    expect(sub.edges).toHaveLength(0)
  })

  it('大批量增删查不报错（200 id）', async () => {
    if (!adapter) return
    const hub = await adapter.addNode({ knowledgeBaseId: KB, name: 'hub', type: 'T' })
    const inputs = Array.from({ length: 200 }, (_, i) => ({
      knowledgeBaseId: KB,
      name: `bulk_${i}`,
      type: 'T',
    }))
    const ids = await adapter.addNodes(inputs)
    expect(ids).toHaveLength(200)
    await adapter.addEdges(
      ids.map((id) => ({ sourceId: hub, targetId: id, relationshipName: 'E', knowledgeBaseId: KB }))
    )
    await adapter.deleteNodes(ids)
    const metrics = await adapter.getGraphMetrics(KB)
    expect(metrics.nodeCount).toBe(1) // 只剩 hub
  })

  it('addNodes NUL 净化写入不报错', async () => {
    if (!adapter) return
    const ids = await adapter.addNodes([
      { knowledgeBaseId: KB, name: 'Bad\0Name', type: 'T\0', properties: { v: 'x\0y' } },
    ])
    const node = await adapter.getNode(ids[0])
    expect(node!.name).toBe('BadName')
    expect(node!.properties.v).toBe('xy')
  })

  it('addEdges NUL 净化写入不报错', async () => {
    if (!adapter) return
    const n1 = await adapter.addNode({ knowledgeBaseId: KB, name: 'A', type: 'T' })
    const n2 = await adapter.addNode({ knowledgeBaseId: KB, name: 'B', type: 'T' })
    await adapter.addEdges([
      { sourceId: n1, targetId: n2, relationshipName: 'KNOWS\0', knowledgeBaseId: KB, properties: { k: 'v\0' } },
    ])
    expect(await adapter.hasEdge(n1, n2, 'KNOWS')).toBe(true)
  })

  it('supportsCypherQueries = false（SQL 适配器契约）', () => {
    if (!adapter) return
    expect(adapter.supportsCypherQueries).toBe(false)
  })

  it('getTripletsBatch：ORDER BY 分页不变量（跨页不重不漏）', async () => {
    if (!adapter) return
    const ids = await adapter.addNodes(
      ['s1', 's2', 's3'].map((n) => ({ knowledgeBaseId: KB, name: n, type: 'T' }))
    )
    const edges: Array<{ sourceId: string; targetId: string; relationshipName: string; knowledgeBaseId: string }> = [
      { sourceId: ids[0], targetId: ids[1], relationshipName: 'E', knowledgeBaseId: KB },
      { sourceId: ids[0], targetId: ids[2], relationshipName: 'E', knowledgeBaseId: KB },
      { sourceId: ids[1], targetId: ids[2], relationshipName: 'E', knowledgeBaseId: KB },
    ]
    await adapter.addEdges(edges)

    // 第一页 2 条 + 第二页 2 条 → 共 3 条，无重复无遗漏
    const page1 = await (adapter as any).getTripletsBatch({ limit: 2, offset: 0, knowledgeBaseId: KB })
    const page2 = await (adapter as any).getTripletsBatch({ limit: 2, offset: 2, knowledgeBaseId: KB })

    expect(page1).toHaveLength(2)
    expect(page2).toHaveLength(1)

    const keys = [...page1, ...page2].map(
      (t: any) => `${t.startNode.id}|${t.relationshipName}|${t.endNode.id}`
    )
    expect(new Set(keys).size).toBe(3) // 不重复
    expect(keys).toHaveLength(3) // 不遗漏

    // 结构契约
    const t0 = page1[0]
    expect(t0.startNode.name).toBeTruthy()
    expect(t0.relationshipName).toBe('E')
    expect(t0.endNode.name).toBeTruthy()
    expect(t0.relationshipProperties).toEqual({})
  })
})

// =============== 个性化权重 no-op 语义（对标 test_personal_weight_ranking.py） ===============

function makeMemNode(id: string, name: string): GraphNode {
  return {
    id, knowledgeBaseId: 'kb', name, type: 'entity',
    properties: {}, frequency: 1, createdAt: new Date(), updatedAt: new Date(),
  }
}

function makeMemEdge(s: string, t: string, rel: string, weight = 1): GraphEdge {
  return {
    sourceId: s, targetId: t, relationshipName: rel, properties: {},
    weight, knowledgeBaseId: 'kb', createdAt: new Date(), updatedAt: new Date(),
  }
}

describe('移植: 个性化权重语义（CogneeGraph）', () => {
  const buildGraph = () => {
    const g = new CogneeGraph()
    g.addNode(makeMemNode('a', 'A'))
    g.addNode(makeMemNode('b', 'B'))
    g.addEdge(makeMemEdge('a', 'b', 'rel', 0.5))
    g.addEdge(makeMemEdge('b', 'a', 'rel2', 0.5))
    return g
  }

  it('个性化权重可重排序三元组', () => {
    // 两条三元组：a→c 与 b→c。基线 a 更近；给 b 强个性化权重后 b 反超
    const g = new CogneeGraph()
    g.addNode(makeMemNode('a', 'A'))
    g.addNode(makeMemNode('b', 'B'))
    g.addNode(makeMemNode('c', 'C'))
    g.addEdge(makeMemEdge('a', 'c', 'rel1', 0.5))
    g.addEdge(makeMemEdge('b', 'c', 'rel2', 0.5))
    // 真实距离（[0,2] 内）：a 比 b 更接近查询
    g.mapVectorDistancesToNodes([1, 0], new Map([
      ['a', [0.95, 0.05]],
      ['b', [0.7, 0.3]],
      ['c', [0.1, 0.9]],
    ]))
    const baseline = g.calculateTopTripletImportances(2)
    expect(baseline[0].source.name).toBe('A')

    // 给 b 强个性化权重 → 顺序翻转（b 距离缩小）
    g.applyPersonalWeights(new Map([['b', 0.95]]))
    const weighted = g.calculateTopTripletImportances(2)
    expect(weighted[0].source.name).toBe('B')
  })

  it('空权重表与无权重基线一致', () => {
    const baseline = buildGraph().calculateTopTripletImportances(2)
    const g = buildGraph()
    g.applyPersonalWeights(new Map())
    const empty = g.calculateTopTripletImportances(2)
    expect(empty.map((t) => `${t.source.id}|${t.relation}`)).toEqual(
      baseline.map((t) => `${t.source.id}|${t.relation}`)
    )
  })

  it('中性权重 0.5 是精确 no-op（分数逐位一致）', () => {
    const baseline = buildGraph().calculateTopTripletImportances(2)
    const g = buildGraph()
    g.applyPersonalWeights(new Map([['a', 0.5], ['b', 0.5]]))
    const neutral = g.calculateTopTripletImportances(2)
    expect(neutral.map((t) => t.score)).toEqual(baseline.map((t) => t.score))
  })

  it('无权重节点保持基线序', () => {
    const g = buildGraph()
    g.applyPersonalWeights(new Map([['nonexistent_node', 0.9]]))
    const result = g.calculateTopTripletImportances(2)
    const baseline = buildGraph().calculateTopTripletImportances(2)
    expect(result.map((t) => `${t.source.id}|${t.relation}`)).toEqual(
      baseline.map((t) => `${t.source.id}|${t.relation}`)
    )
  })
})