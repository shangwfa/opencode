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

  it('G-GAP-01 知识库隔离：相同实体名在不同知识库独立读写与删除', async () => {
    const kbA = 'acceptance_isolation_a'
    const kbB = 'acceptance_isolation_b'
    await adapter.deleteGraph(kbA)
    await adapter.deleteGraph(kbB)

    const graphBuilder = new GraphBuilder(adapter)
    await graphBuilder.buildFromExtraction({
      entities: [{ name: '隔离主体', type: 'concept' }, { name: '知识库A目标', type: 'concept' }],
      triplets: [{ source: '隔离主体', relation: '仅属于A', target: '知识库A目标', confidence: 0.9 }],
    }, { knowledgeBaseId: kbA, documentId: 'isolation-doc-a' })
    await graphBuilder.buildFromExtraction({
      entities: [{ name: '隔离主体', type: 'concept' }, { name: '知识库B目标', type: 'concept' }],
      triplets: [{ source: '隔离主体', relation: '仅属于B', target: '知识库B目标', confidence: 0.9 }],
    }, { knowledgeBaseId: kbB, documentId: 'isolation-doc-b' })

    const graphA = await adapter.getGraphData(kbA)
    const graphB = await adapter.getGraphData(kbB)
    expect(graphA.nodes.map((node) => node.name)).toContain('知识库A目标')
    expect(graphA.nodes.map((node) => node.name)).not.toContain('知识库B目标')
    expect(graphA.edges.some((edge) => edge.relationshipName === '仅属于A')).toBe(true)
    expect(graphA.edges.some((edge) => edge.relationshipName === '仅属于B')).toBe(false)
    expect(graphB.nodes.map((node) => node.name)).toContain('知识库B目标')
    expect(graphB.nodes.map((node) => node.name)).not.toContain('知识库A目标')
    expect(graphB.edges.some((edge) => edge.relationshipName === '仅属于B')).toBe(true)

    await new UnifiedStoreEngine(adapter, undefined, SCHEMA).deleteByKnowledgeBase(kbA)
    expect((await adapter.getGraphData(kbA).then((data) => data.nodes))).toHaveLength(0)
    expect((await adapter.getGraphData(kbB)).nodes.map((node) => node.name)).toContain('知识库B目标')
  })

  it('G-GAP-03 文档删除边界：不存在文档与相似前缀文档互不影响', async () => {
    const kb = 'acceptance_delete_boundaries'
    await adapter.deleteGraph(kb)
    const graphBuilder = new GraphBuilder(adapter)
    await graphBuilder.buildFromExtraction({
      entities: [
        { name: '前缀文档实体', type: 'concept' },
        { name: '前缀文档目标', type: 'concept' },
      ],
      triplets: [{ source: '前缀文档实体', relation: '关联', target: '前缀文档目标', confidence: 0.9 }],
    }, { knowledgeBaseId: kb, documentId: 'doc-boundary' })
    await graphBuilder.buildFromExtraction({
      entities: [
        { name: '扩展文档实体', type: 'concept' },
        { name: '扩展文档目标', type: 'concept' },
      ],
      triplets: [{ source: '扩展文档实体', relation: '关联', target: '扩展文档目标', confidence: 0.9 }],
    }, { knowledgeBaseId: kb, documentId: 'doc-boundary-extra' })

    const engine = new UnifiedStoreEngine(adapter, undefined, SCHEMA)
    const missing = await engine.deleteByDocument('does-not-exist', kb)
    expect(missing.deletedNodeIds).toHaveLength(0)
    expect((await adapter.getGraphData(kb)).nodes.map((node) => node.name)).toEqual(
      expect.arrayContaining(['前缀文档实体', '扩展文档实体'])
    )

    await engine.deleteByDocument('doc-boundary', kb)
    const names = (await adapter.getGraphData(kb)).nodes.map((node) => node.name)
    expect(names).not.toContain('前缀文档实体')
    expect(names).toContain('扩展文档实体')
    expect(await adapter.getNodeIdsByDocument('doc-boundary-extra')).toHaveLength(2)
  })

  it('G-GAP-02 共享图数据溯源删除：删除一个来源保留另一个来源，删除最后来源后清理', async () => {
    const kb = 'acceptance_shared_provenance'
    await adapter.deleteGraph(kb)
    const graphBuilder = new GraphBuilder(adapter)
    const sharedExtraction = {
      entities: [
        { name: '共享服务A', type: 'service' },
        { name: '共享服务B', type: 'service' },
      ],
      triplets: [{ source: '共享服务A', relation: '调用', target: '共享服务B', confidence: 0.9 }],
    }
    await graphBuilder.buildFromExtraction(sharedExtraction, {
      knowledgeBaseId: kb,
      documentId: 'shared-source-a',
    })
    await graphBuilder.buildFromExtraction(sharedExtraction, {
      knowledgeBaseId: kb,
      documentId: 'shared-source-b',
    })

    const nodesFromA = await adapter.getNodeIdsByDocument('shared-source-a')
    const nodesFromB = await adapter.getNodeIdsByDocument('shared-source-b')
    expect(nodesFromA).toHaveLength(2)
    expect(nodesFromB).toHaveLength(2)
    expect(new Set(nodesFromA)).toEqual(new Set(nodesFromB))

    const engine = new UnifiedStoreEngine(adapter, undefined, SCHEMA)
    await engine.deleteByDocument('shared-source-a', kb)
    const afterFirstDelete = await adapter.getGraphData(kb)
    expect(afterFirstDelete.nodes.map((node) => node.name).sort()).toEqual(['共享服务A', '共享服务B'])
    expect(afterFirstDelete.edges.some((edge) => edge.relationshipName === '调用')).toBe(true)
    expect(await adapter.getNodeIdsByDocument('shared-source-a')).toHaveLength(0)
    expect(await adapter.getNodeIdsByDocument('shared-source-b')).toHaveLength(2)

    await engine.deleteByDocument('shared-source-b', kb)
    expect((await adapter.getGraphData(kb)).nodes).toHaveLength(0)
    expect(await adapter.getNodeIdsByDocument('shared-source-b')).toHaveLength(0)
  })

  it('G-GAP-13 仅实体入库：无关系 extraction 仍记录文档来源并可按文档删除', async () => {
    const kb = 'acceptance_entity_only'
    await adapter.deleteGraph(kb)
    const graphBuilder = new GraphBuilder(adapter)
    await graphBuilder.buildFromExtraction({
      entities: [{ name: '无关系独立实体', type: 'concept' }],
      triplets: [],
    }, { knowledgeBaseId: kb, documentId: 'entity-only-document' })

    const ids = await adapter.getNodeIdsByDocument('entity-only-document')
    expect(ids).toHaveLength(1)
    expect((await adapter.getNode(ids[0]))?.name).toBe('无关系独立实体')

    await new UnifiedStoreEngine(adapter, undefined, SCHEMA)
      .deleteByDocument('entity-only-document', kb)
    expect(await adapter.getNodeIdsByDocument('entity-only-document')).toHaveLength(0)
    expect((await adapter.getGraphData(kb)).nodes).toHaveLength(0)
  })

  it('G-GAP-14 并发导入：共享节点和边去重且保留全部文档关联', async () => {
    const kb = 'acceptance_concurrent_ingest'
    await adapter.deleteGraph(kb)
    const graphBuilder = new GraphBuilder(adapter)
    const extraction = {
      entities: [
        { name: '并发共享服务A', type: 'service' },
        { name: '并发共享服务B', type: 'service' },
      ],
      triplets: [{ source: '并发共享服务A', relation: '调用', target: '并发共享服务B', confidence: 0.9 }],
    }
    const documentIds = ['parallel-doc-1', 'parallel-doc-2', 'parallel-doc-3']

    await Promise.all(documentIds.map((documentId) => graphBuilder.buildFromExtraction(extraction, {
      knowledgeBaseId: kb,
      documentId,
      buildEntityTypeNodes: false,
    })))

    const graph = await adapter.getGraphData(kb)
    expect(graph.nodes).toHaveLength(2)
    expect(graph.edges.filter((edge) => edge.relationshipName === '调用')).toHaveLength(1)
    for (const documentId of documentIds) {
      expect(await adapter.getNodeIdsByDocument(documentId)).toHaveLength(2)
    }
    expect((await adapter.findNodeByName('并发共享服务A', kb))!.frequency).toBe(3)
  })

  it('G-GAP-15 边来源跨篇并集：多篇写同一条边时 sourceDocumentIds 不被覆盖', async () => {
    const kb = 'acceptance_edge_source_union'
    await adapter.deleteGraph(kb)
    const graphBuilder = new GraphBuilder(adapter)
    const extraction = {
      entities: [
        { name: '并集主体', type: 'concept' },
        { name: '并集目标', type: 'concept' },
      ],
      triplets: [{ source: '并集主体', relation: '关联', target: '并集目标', confidence: 0.9 }],
    }
    // GraphBuilder 单值来源；直接用 merge 管线的聚合写法验证边 upsert 并集语义
    const { GraphMergePipeline } = await import('../extraction/merge-pipeline.js')
    const pipeline = new GraphMergePipeline(adapter, adapter.chunkTracker)
    for (const documentId of ['union-doc-a', 'union-doc-b']) {
      await pipeline.merge(
        [{
          extraction: extraction as never,
          chunkId: `${documentId}#0`,
          chunkIndex: 0,
          documentId,
        }],
        { knowledgeBaseId: kb, buildEntityTypeNodes: false }
      )
    }
    const source = await adapter.findNodeByName('并集主体', kb)
    const edges = await adapter.getEdges(source!.id)
    const edge = edges.find((e) => e.relationshipName === '关联')!
    const docs = edge.properties.sourceDocumentIds as string[]
    expect([...docs].sort()).toEqual(['union-doc-a', 'union-doc-b'])
  })

  it('G-GAP-16 删除同步清理：detach 节点减频，RDF/chunk 溯源不残留', async () => {
    const kb = 'acceptance_delete_sync'
    await adapter.deleteGraph(kb)
    const graphBuilder = new GraphBuilder(adapter)
    const extraction = {
      entities: [
        { name: '同步共享实体', type: 'concept' },
        { name: '同步独占实体', type: 'concept' },
      ],
      triplets: [{ source: '同步共享实体', relation: '关联', target: '同步独占实体', confidence: 0.9 }],
    }
    await graphBuilder.buildFromExtraction(extraction, { knowledgeBaseId: kb, documentId: 'sync-doc-1', buildEntityTypeNodes: false })
    await graphBuilder.buildFromExtraction(extraction, { knowledgeBaseId: kb, documentId: 'sync-doc-2', buildEntityTypeNodes: false })

    const sharedBefore = (await adapter.findNodeByName('同步共享实体', kb))!.frequency
    expect(sharedBefore).toBe(2)

    // 删除一个来源：共享实体保留且 frequency 回减；RDF/chunk 溯源清理
    await new UnifiedStoreEngine(adapter, undefined, SCHEMA).deleteByDocument('sync-doc-1', kb)
    const shared = await adapter.findNodeByName('同步共享实体', kb)
    expect(shared).not.toBeNull()
    expect(shared!.frequency).toBe(1)
    expect(await adapter.getNodeIdsByDocument('sync-doc-1')).toHaveLength(0)
    const rdfLeft = await adapter.rdfStore.match({ graph: `urn:graph:knowledge:${kb}` })
    expect(rdfLeft.filter((q) => String(q.sourceChunkId ?? '').startsWith('sync-doc-1#'))).toHaveLength(0)
  })

  it('G-GAP-17 文档更新替换：updateMode=replace 时旧事实被替换且不虚增 frequency（默认 append 行为不变）', async () => {
    const kb = 'acceptance_update_replace'
    await adapter.deleteGraph(kb)
    const { DocumentIngestPipeline } = await import('../pipeline/document-pipeline.js')
    const pipeline = new DocumentIngestPipeline(adapter, {
      embedFn: async (texts: string[]) => texts.map(() => Array(64).fill(0.1)),
    })

    const v1 = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '旧版本事实：甲关联乙。' }] }] }
    const v2 = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '新版本事实：甲关联丙。' }] }] }

    const { mock } = await import('bun:test')
    const { EntityExtractor } = await import('../extraction/entity-extractor.js' + '?real')
    const extractMock = mock(async (text: string) => text.includes('新版本')
      ? { entities: [{ name: '甲', type: 'concept' }, { name: '丙', type: 'concept' }], triplets: [{ source: '甲', relation: '关联', target: '丙', confidence: 0.9 }] }
      : { entities: [{ name: '甲', type: 'concept' }, { name: '乙', type: 'concept' }], triplets: [{ source: '甲', relation: '关联', target: '乙', confidence: 0.9 }] })
    mock.module('../extraction/entity-extractor.js', () => ({
      EntityExtractor: class { extract = extractMock; constructor(_o?: unknown) {} },
    }))
    try {
      await pipeline.ingest(v1, { type: 'tiptap', knowledgeBaseId: kb, documentId: 'update-doc' })
      expect((await adapter.getGraphData(kb)).nodes.map((n) => n.name)).toContain('乙')
      expect((await adapter.findNodeByName('甲', kb))!.frequency).toBe(1)

      // 默认 append（现状语义）：不清理旧事实，乙保留、甲频率累计
      await pipeline.ingest(v1, { type: 'tiptap', knowledgeBaseId: kb, documentId: 'update-doc' })
      expect((await adapter.getGraphData(kb)).nodes.map((n) => n.name)).toContain('乙')
      expect((await adapter.findNodeByName('甲', kb))!.frequency).toBe(2)

      // opt-in replace：旧实体乙被清（unowned），新实体丙入图，甲频率回到 1（先删旧再写新）
      await pipeline.ingest(v2, { type: 'tiptap', knowledgeBaseId: kb, documentId: 'update-doc', updateMode: 'replace' })
      const after = await adapter.getGraphData(kb)
      expect(after.nodes.map((n) => n.name)).not.toContain('乙')
      expect(after.nodes.map((n) => n.name)).toContain('丙')
      expect((await adapter.findNodeByName('甲', kb))!.frequency).toBe(1)
    } finally {
      mock.module('../extraction/entity-extractor.js', () => EntityExtractor as never)
    }
  })
})
