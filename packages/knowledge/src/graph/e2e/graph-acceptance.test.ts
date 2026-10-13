/**
 * 固定图谱验收用例（P0）。
 * 这些用例不调用 LLM，专门验证迁移后的图语义和核心不变量。
 * 运行：DATABASE_URL="..." npx vitest run src/graph/e2e/graph-acceptance.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { Pool } from 'pg'
import { PgGraphAdapter } from '../pg-adapter/adapter.js'
import { GraphBuilder } from '../extraction/graph-builder.js'
import { EntityConsolidator } from '../algorithms/entity-consolidator.js'
import { TemporalConflictResolver, filterActiveEdges } from '../algorithms/temporal-conflict-resolver.js'
import { TripletRetriever } from '../retrieval/retriever-variants.js'
import { UnifiedStoreEngine } from '../unified/engine.js'
import { BACKEND_SERVICE_FIXTURES, CONFLICT_FIXTURE } from './fixtures/backend-services.js'

const SCHEMA = 'test_graph_acceptance'
const KB = 'acceptance_backend_services'

describe.skipIf(!process.env.DATABASE_URL)('固定图谱验收 P0', () => {
  let pool: Pool
  let adapter: PgGraphAdapter
  let builder: GraphBuilder

  beforeAll(async () => {
    const connectionString = process.env.DATABASE_URL || ''
    if (!connectionString) throw new Error('需要 DATABASE_URL（本地库）')
    pool = new Pool({ connectionString })
    adapter = new PgGraphAdapter(pool, SCHEMA, 64)
    await adapter.init()
  })

  beforeEach(async () => {
    await adapter.deleteGraph(KB)
    builder = new GraphBuilder(adapter)
  })

  afterAll(async () => {
    await adapter.deleteGraph()
    await pool.end()
  })

  it('P0-1 基础建图：节点、方向、关系和来源正确', async () => {
    for (const fixture of BACKEND_SERVICE_FIXTURES) {
      await builder.buildFromExtraction(fixture.extraction, {
        knowledgeBaseId: KB,
        documentId: fixture.id,
      })
    }

    const graph = await adapter.getGraphData(KB)
    expect(graph.nodes.map((node) => `${node.type}:${node.name}`).sort()).toEqual([
      'database:库存数据库',
      'database:订单数据库',
      'message_queue:库存队列',
      'service:库存服务',
      'service:订单服务',
    ])
    expect(graph.edges.map((edge) => `${edge.relationshipName}:${edge.sourceId}:${edge.targetId}`)).toHaveLength(4)

    const order = await adapter.findNodeByName('订单服务', KB)
    expect(order).not.toBeNull()
    const call = graph.edges.find((edge) => edge.relationshipName === '调用')!
    expect(call.sourceId).toBe(order!.id)
    expect(call.properties.sourceDocumentId).toBe('doc-order-service')
  })

  it('P0-2 重复导入幂等：节点和边不重复，频率可累计', async () => {
    const fixture = BACKEND_SERVICE_FIXTURES[0]
    await builder.buildFromExtraction(fixture.extraction, { knowledgeBaseId: KB, documentId: fixture.id })
    await builder.buildFromExtraction(fixture.extraction, { knowledgeBaseId: KB, documentId: fixture.id })

    const graph = await adapter.getGraphData(KB)
    expect(graph.nodes).toHaveLength(3)
    expect(graph.edges).toHaveLength(2)
    expect((await adapter.findNodeByName('订单服务', KB))!.frequency).toBeGreaterThanOrEqual(2)
  })

  it('P0-3 关系检索去噪：只返回指定主体和关系', async () => {
    for (const fixture of BACKEND_SERVICE_FIXTURES) {
      await builder.buildFromExtraction(fixture.extraction, { knowledgeBaseId: KB, documentId: fixture.id })
    }

    const retriever = new TripletRetriever(adapter)
    const result = await retriever.search([1, 0, 0], {
      topK: 5,
      neighborDepth: 1,
      knowledgeBaseId: KB,
      relationTypes: ['调用'],
      sourceNames: ['订单服务'],
    })

    expect(result.triplets).toHaveLength(1)
    expect(result.triplets[0].source.name).toBe('订单服务')
    expect(result.triplets[0].relation).toBe('调用')
    expect(result.triplets[0].target.name).toBe('库存服务')
  })

  it('P0-4 文档删除：独占节点删除，共享节点保留', async () => {
    for (const fixture of BACKEND_SERVICE_FIXTURES) {
      await builder.buildFromExtraction(fixture.extraction, { knowledgeBaseId: KB, documentId: fixture.id })
    }

    const engine = new UnifiedStoreEngine(adapter, undefined, SCHEMA)
    await engine.deleteByDocument('doc-order-service', KB)

    const graph = await adapter.getGraphData(KB)
    const names = graph.nodes.map((node) => node.name)
    expect(names).toContain('库存服务')
    expect(names).toContain('库存数据库')
    expect(names).not.toContain('订单服务')
    expect(names).not.toContain('订单数据库')
    expect(await adapter.getNodeIdsByDocument('doc-order-service')).toHaveLength(0)
  })

  it('P0-5 事实冲突：按生效日期保留最新断言并隐藏旧断言', async () => {
    await builder.buildFromExtraction(CONFLICT_FIXTURE, {
      knowledgeBaseId: KB,
      documentId: 'doc-deployment-conflict',
    })

    const resolver = new TemporalConflictResolver(adapter, {
      functionalRelations: ['部署于'],
    })
    const resolved = await resolver.resolve(KB)
    expect(resolved.supersededEdgeCount).toBe(1)

    const service = await adapter.findNodeByName('订单服务', KB)
    const active = filterActiveEdges(await adapter.getEdges(service!.id))
      .filter((edge) => edge.relationshipName === '部署于')
    expect(active).toHaveLength(1)
    expect(active[0].relationshipName).toBe('部署于')
    expect((await adapter.findNodeByName('生产集群B', KB))!.id).toBe(active[0].targetId)
    expect(active[0].properties.sourceDocumentId).toBe('doc-deployment-conflict')
  })
})
