import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Pool } from 'pg'
import { PgGraphAdapter } from './pg-adapter/adapter.js'
import { EntityConsolidator, normalizeEntityName } from './algorithms/entity-consolidator.js'
import { EdgeTypeIndexer } from './algorithms/edge-type-indexer.js'
import { UnifiedStoreEngine } from './unified/engine.js'
import { GraphCompletionRetriever } from './retrieval/graph-completion-retriever.js'
import { ContradictionDetector } from './algorithms/contradiction-detector.js'

const TEST_SCHEMA = 'test_round3'

// ---------- 纯单元测试 ----------

describe('normalizeEntityName (unit)', () => {
  it('应归一化空白和标点', () => {
    expect(normalizeEntityName('  Python 3 ')).toBe('python3')
    expect(normalizeEntityName('影刀-RPA')).toBe('影刀rpa')
    expect(normalizeEntityName('（测试）')).toBe('测试')
    expect(normalizeEntityName('Node.js。')).toBe('node.js') // 中间点有语义（版本号）保留，仅去尾部标点
  })

  it('同义写法应归一为相同键', () => {
    expect(normalizeEntityName('Fast API')).toBe(normalizeEntityName('fastapi'))
    expect(normalizeEntityName('影刀 RPA')).toBe(normalizeEntityName('影刀RPA'))
  })
})

// ---------- 集成测试（本地数据库） ----------

describe('第三轮修复 集成测试', () => {
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

  it('[Bug1] GraphBuilder 写入关联表后 deleteByDocument 真正删除图数据', async () => {
    if (!adapter) return
    const { GraphBuilder } = await import('./extraction/graph-builder.js')
    const builder = new GraphBuilder(adapter)
    await builder.buildFromExtraction(
      {
        entities: [
          { name: '实体A', type: 'concept' },
          { name: '实体B', type: 'concept' },
        ],
        triplets: [{ source: '实体A', relation: '关联', target: '实体B', confidence: 0.9 }],
      },
      { knowledgeBaseId: 'kb_bug1', documentId: 'doc_1' }
    )

    // 关联表应有记录
    const linked = await adapter.getNodeIdsByDocument('doc_1')
    expect(linked.length).toBe(2)

    // 删除前图非空
    expect(await adapter.isGraphEmpty('kb_bug1')).toBe(false)

    const engine = new UnifiedStoreEngine(adapter, undefined, TEST_SCHEMA)
    const result = await engine.deleteByDocument('doc_1', 'kb_bug1')

    // 核心断言：图节点/边被真实删除（之前是形同虚设）
    expect(result.deletedNodeIds.length).toBe(2)
    expect(result.deletedEdgeCount).toBe(1)
    expect(await adapter.isGraphEmpty('kb_bug1')).toBe(true)
  })

  it('[Bug1] 兜底路径：无关联表记录时按属性反查删除', async () => {
    if (!adapter) return
    // 直接 addNode（不写关联表），只靠 properties.sourceDocumentId
    await adapter.addNode({
      knowledgeBaseId: 'kb_fb',
      name: '兜底节点',
      type: 'concept',
      properties: { sourceDocumentId: 'doc_fallback' },
    })

    const engine = new UnifiedStoreEngine(adapter, undefined, TEST_SCHEMA)
    const result = await engine.deleteByDocument('doc_fallback', 'kb_fb')
    expect(result.deletedNodeIds.length).toBe(1)
  })

  it('[Bug2] findSimilarNodesByEmbedding SQL 侧 ANN top-K + 类型过滤', async () => {
    if (!adapter) return
    await adapter.addNode({
      knowledgeBaseId: 'kb_ann', name: 'Python', type: 'language',
      embedding: [1, 0, 0, 0],
    })
    await adapter.addNode({
      knowledgeBaseId: 'kb_ann', name: 'Java', type: 'language',
      embedding: [0, 1, 0, 0],
    })
    await adapter.addNode({
      knowledgeBaseId: 'kb_ann', name: 'helpers.ts', type: 'code_file',
      embedding: [1, 0, 0, 0], // 与查询最相似但是结构节点
    })

    const results = await adapter.findSimilarNodesByEmbedding({
      embedding: [1, 0, 0, 0],
      topK: 3,
      knowledgeBaseId: 'kb_ann',
      excludeTypes: ['code_file', 'code_module'],
    })

    // 结构节点被排除，Python 排第一
    expect(results.length).toBeLessThanOrEqual(2)
    expect(results[0].name).toBe('Python')
    expect(results.every((r) => r.type !== 'code_file')).toBe(true)
  })

  it('[Bug2] GraphCompletionRetriever 使用 ANN 种子检索', async () => {
    if (!adapter) return
    await adapter.addNode({
      knowledgeBaseId: 'kb_ret', name: 'Python', type: 'language',
      embedding: [1, 0, 0, 0],
    })
    const n2 = await adapter.addNode({
      knowledgeBaseId: 'kb_ret', name: 'FastAPI', type: 'technology',
      embedding: [0.9, 0.1, 0, 0],
    })
    await adapter.addEdge({
      sourceId: (await adapter.findNodeByName('Python', 'kb_ret'))!.id,
      targetId: n2,
      relationshipName: '用于',
      knowledgeBaseId: 'kb_ret',
    })

    const retriever = new GraphCompletionRetriever(adapter)
    const result = await retriever.search([1, 0, 0, 0], {
      topK: 5,
      neighborDepth: 1,
      knowledgeBaseId: 'kb_ret',
    })
    expect(result.triplets.length).toBeGreaterThanOrEqual(1)
    expect(result.triplets[0].source.name).toBe('Python')
  })

  it('#1 EntityConsolidator 同名归一合并（含边迁移）', async () => {
    if (!adapter) return
    const a = await adapter.addNode({ knowledgeBaseId: 'kb_merge', name: 'Python', type: 'language', frequency: 5 })
    const dup = await adapter.addNode({ knowledgeBaseId: 'kb_merge', name: ' python ', type: 'language', frequency: 1 })
    const other = await adapter.addNode({ knowledgeBaseId: 'kb_merge', name: 'AI', type: 'concept' })
    await adapter.addEdge({ sourceId: dup, targetId: other, relationshipName: '用于', knowledgeBaseId: 'kb_merge' })

    const consolidator = new EntityConsolidator(adapter)

    // dryRun 只报告不执行
    const dry = await consolidator.consolidate({ knowledgeBaseId: 'kb_merge', dryRun: true })
    expect(dry.candidates.length).toBe(1)
    expect(dry.candidates[0].reason).toBe('same_normalized_name')
    expect(await adapter.getNode(dup)).not.toBeNull()

    // 实际合并
    const result = await consolidator.consolidate({ knowledgeBaseId: 'kb_merge' })
    expect(result.mergedCount).toBe(1)
    expect(await adapter.getNode(dup)).toBeNull()

    // 边已迁移到主节点
    const primaryEdges = await adapter.getEdges(a)
    expect(primaryEdges.length).toBe(1)
    expect(primaryEdges[0].targetId).toBe(other)

    // 频率累加
    const primary = await adapter.getNode(a)
    expect(primary!.frequency).toBeGreaterThanOrEqual(6)
  })

  it('#1 EntityConsolidator 嵌入相似度合并（同类型）且禁跨类型', async () => {
    if (!adapter) return
    await adapter.addNode({
      knowledgeBaseId: 'kb_emb_merge', name: 'NodeOne', type: 'concept',
      embedding: [1, 0, 0, 0], frequency: 3,
    })
    await adapter.addNode({
      knowledgeBaseId: 'kb_emb_merge', name: 'NodeOnePrime', type: 'concept',
      embedding: [0.99, 0.02, 0, 0], frequency: 1,
    })
    // 同嵌入但类型不同 → 不合并
    await adapter.addNode({
      knowledgeBaseId: 'kb_emb_merge', name: 'DiffType', type: 'product',
      embedding: [1, 0, 0, 0], frequency: 1,
    })

    const consolidator = new EntityConsolidator(adapter)
    const result = await consolidator.consolidate({ knowledgeBaseId: 'kb_emb_merge' })

    expect(result.mergedCount).toBe(1)
    const diffType = await adapter.findNodeByName('DiffType', 'kb_emb_merge')
    expect(diffType).not.toBeNull()
  })

  it('#2 getSubgraphByNodeSetLabel 按 belongsToSet 标签拉子图', async () => {
    if (!adapter) return
    const indexer = new EdgeTypeIndexer(adapter)
    const n1 = await adapter.addNode({ knowledgeBaseId: 'kb_set', name: 'A', type: 'concept' })
    const n2 = await adapter.addNode({ knowledgeBaseId: 'kb_set', name: 'B', type: 'concept' })
    await adapter.addNode({ knowledgeBaseId: 'kb_set', name: 'C', type: 'concept' })
    await adapter.addEdge({ sourceId: n1, targetId: n2, relationshipName: 'rel', knowledgeBaseId: 'kb_set' })

    await indexer.tagNodesWithSet([n1, n2], 'session_learnings')

    const sub = await (adapter as any).getSubgraphByNodeSetLabel('session_learnings', 'kb_set')
    expect(sub.nodes.length).toBe(2)
    expect(sub.edges.length).toBe(1)

    const none = await (adapter as any).getSubgraphByNodeSetLabel('nonexistent_set', 'kb_set')
    expect(none.nodes.length).toBe(0)
  })

  it('#7 EdgeTypeIndexer 维护关系统计节点', async () => {
    if (!adapter) return
    const n1 = await adapter.addNode({ knowledgeBaseId: 'kb_et', name: 'A', type: 'concept' })
    const n2 = await adapter.addNode({ knowledgeBaseId: 'kb_et', name: 'B', type: 'concept' })
    const n3 = await adapter.addNode({ knowledgeBaseId: 'kb_et', name: 'C', type: 'concept' })
    await adapter.addEdge({ sourceId: n1, targetId: n2, relationshipName: '使用', knowledgeBaseId: 'kb_et' })
    await adapter.addEdge({ sourceId: n2, targetId: n3, relationshipName: '使用', knowledgeBaseId: 'kb_et' })
    await adapter.addEdge({ sourceId: n1, targetId: n3, relationshipName: '依赖', knowledgeBaseId: 'kb_et' })

    const indexer = new EdgeTypeIndexer(adapter)
    const result = await indexer.refresh('kb_et')
    expect(result.typeCount).toBe(2)

    const types = await indexer.listEdgeTypes()
    expect(types.find((t) => t.name === '使用')?.count).toBe(2)
    expect(types.find((t) => t.name === '依赖')?.count).toBe(1)
  })

  it('#12 ContradictionDetector LLM 不可用时降级纯规则', async () => {
    if (!adapter) return
    const n1 = await adapter.addNode({ knowledgeBaseId: 'kb_cd', name: 'A', type: 'concept' })
    const n2 = await adapter.addNode({ knowledgeBaseId: 'kb_cd', name: 'B', type: 'concept' })
    await adapter.addEdge({ sourceId: n1, targetId: n2, relationshipName: '支持', knowledgeBaseId: 'kb_cd' })
    await adapter.addEdge({ sourceId: n1, targetId: n2, relationshipName: '不支持', knowledgeBaseId: 'kb_cd' })

    // 传 null model 禁用 LLM
    const detector = new ContradictionDetector(adapter, { model: null as any })
    const result = await detector.detect('kb_cd')
    expect(result.contradictions.length).toBeGreaterThanOrEqual(1)
    expect(result.semanticContradictions).toEqual([])
    expect(result.contradictsEdgesWritten).toBe(0)
  })
})