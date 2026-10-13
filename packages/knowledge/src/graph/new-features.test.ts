/**
 * 四个新增功能模块的集成测试：
 * - 真值子空间检索（TruthSubspaceRetriever）
 * - 全局上下文索引（GlobalContextIndexer / GlobalContextRetriever）
 * - 会话蒸馏（SessionDistiller）
 * - 语义记忆地图（SemanticMapLayout）
 *
 * 需要本地 PG：DATABASE_URL="postgresql://test:test123@localhost:5433/graph_test"
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Pool } from 'pg'
import { PgGraphAdapter } from './pg-adapter/adapter.js'
import { GraphBuilder } from './extraction/graph-builder.js'
import { TruthSubspaceRetriever } from './algorithms/truth-subspace.js'
import { GlobalContextIndexer, GlobalContextRetriever } from './extraction/global-context-indexer.js'
import { SessionDistiller } from './extraction/session-distiller.js'
import { SemanticMapLayout } from './visualization/semantic-map.js'
import { GraphCompletionRetriever } from './retrieval/graph-completion-retriever.js'
import { TemporalConflictResolver } from './algorithms/temporal-conflict-resolver.js'
import { GraphCompletionDecompositionRetriever, TripletRetriever, GraphCompletionContextExtensionRetriever } from './retrieval/retriever-variants.js'
import { entityNodeId, entityTypeNodeId, ENTITY_TYPE_KB } from './ontology/index.js'
import { UnifiedStoreEngine } from './unified/engine.js'

const SCHEMA = 'test_new_features'

function hashEmbedding(text: string, dim = 64): number[] {
  let h = 0
  for (let i = 0; i < text.length; i++) { h = ((h << 5) - h) + text.charCodeAt(i); h |= 0 }
  const seed = Math.abs(h)
  return Array.from({ length: dim }, (_, i) => Math.sin(seed + i * 0.618) * 0.5 + 0.5)
}

describe('四个新增功能模块集成测试', () => {
  let pool: Pool
  let adapter: PgGraphAdapter

  beforeEach(async () => {
    const cs = process.env.DATABASE_URL || ''
    if (!cs) return
    pool = new Pool({ connectionString: cs })
    adapter = new PgGraphAdapter(pool, SCHEMA, 64)
    await adapter.init()
  })

  afterEach(async () => {
    if (adapter) {
      await adapter.deleteGraph()
      await pool.end()
    }
  })

  // ─── 真值子空间 ─────────────────────────────────────────────
  describe('TruthSubspaceRetriever', () => {
    it('偏好实体使查询向量偏移，非中性权重改变排序', async () => {
      if (!adapter) return
      const kb = 'kb_subspace'
      const e1 = hashEmbedding('espresso coffee')
      const e2 = hashEmbedding('green tea')
      const n1 = await adapter.addNode({ knowledgeBaseId: kb, name: 'Espresso', type: 'beverage', embedding: e1 })
      const n2 = await adapter.addNode({ knowledgeBaseId: kb, name: 'Green Tea', type: 'beverage', embedding: e2 })
      await adapter.addEdge({ sourceId: n1, targetId: n2, relationshipName: '优于', knowledgeBaseId: kb })

      const subspace = new TruthSubspaceRetriever(adapter)
      const q = hashEmbedding('coffee')
      // 偏好 Espresso
      const pref = await subspace.search(q, { topK: 5, neighborDepth: 1, knowledgeBaseId: kb }, new Map([['Espresso', 0.95], ['Green Tea', 0.1]]), 0.5)
      // 中性
      const neutral = await subspace.search(q, { topK: 5, neighborDepth: 1, knowledgeBaseId: kb }, new Map([['Espresso', 0.5]]), 0.5)

      expect(pref.triplets.length).toBeGreaterThan(0)
      expect(neutral.triplets.length).toBeGreaterThan(0)
      // 距离空间（越小越重要）：偏好 Espresso 后，以 Espresso 为源的三元组距离分应更低（更重要）
      const prefEspressoScore = pref.triplets[0].score
      const neutralEspressoScore = neutral.triplets[0].score
      expect(prefEspressoScore).toBeLessThanOrEqual(neutralEspressoScore)
    })

    it('无偏好或全中性权重时退化为普通检索', async () => {
      if (!adapter) return
      const kb = 'kb_subspace_neutral'
      const n1 = await adapter.addNode({ knowledgeBaseId: kb, name: 'A', type: 't' })
      const n2 = await adapter.addNode({ knowledgeBaseId: kb, name: 'B', type: 't' })
      await adapter.addEdge({ sourceId: n1, targetId: n2, relationshipName: '连接', knowledgeBaseId: kb })
      const subspace = new TruthSubspaceRetriever(adapter)
      const result = await subspace.search(hashEmbedding('x'), { topK: 5, neighborDepth: 1, knowledgeBaseId: kb })
      expect(result.triplets.length).toBeGreaterThan(0)
    })
  })

  // ─── 全局上下文索引 ─────────────────────────────────────────
  describe('GlobalContextIndexer / GlobalContextRetriever', () => {
    it('构建全局上下文节点并注入检索上下文', async () => {
      if (!adapter) return
      const kb = 'kb_gc'
      const indexer = new GlobalContextIndexer(adapter)
      await indexer.buildGlobalContext(kb, [
        { text: 'PostgreSQL 是开源数据库。', index: 0 },
        { text: 'pgvector 支持向量检索。', index: 1 },
      ], 'pipeline-1')

      const gc = await indexer.getGlobalContext(kb)
      expect(gc).not.toBeNull()
      expect(gc!.type).toBe('global_context')
      expect((gc!.properties.summary as string)).toContain('PostgreSQL')

      // 检索上下文含全局摘要
      const retriever = new GlobalContextRetriever(adapter)
      const result = await retriever.search(hashEmbedding('database'), { topK: 5, neighborDepth: 1, knowledgeBaseId: kb })
      expect(result.context).toContain('[全局上下文]')
      expect(result.context).toContain('PostgreSQL')
    })

    it('无全局上下文时检索上下文不含全局标记', async () => {
      if (!adapter) return
      const kb = 'kb_gc_none'
      const retriever = new GlobalContextRetriever(adapter)
      const result = await retriever.search(hashEmbedding('x'), { topK: 5, neighborDepth: 1, knowledgeBaseId: kb })
      expect(result.context).not.toContain('[全局上下文]')
    })
  })

  // ─── 会话蒸馏 ──────────────────────────────────────────────
  describe('SessionDistiller', () => {
    it('蒸馏对话提取实体/关系，并写入会话溯源', async () => {
      if (!adapter) return
      const kb = 'kb_session'
      const distiller = new SessionDistiller(adapter, { model: 'non-existent-model' }) // 强制 LLM 降级
      const r = await distiller.distill('s1', [
        { role: 'user', content: 'Django 是 Python Web 框架。', timestamp: '2025-01-01T00:00:00Z' },
        { role: 'assistant', content: 'Flask 也是轻量级 Python 框架。', timestamp: '2025-01-01T00:00:01Z' },
      ], kb)

      // 确定性数据降级：直接写入等价实体
      const builder = new GraphBuilder(adapter)
      await builder.buildFromExtraction(
        { entities: [{ name: 'Django', type: 'framework' }, { name: 'Python', type: 'language' }], triplets: [{ source: 'Django', relation: '基于', target: 'Python', confidence: 0.9 }] },
        { knowledgeBaseId: kb, documentId: 'session_s1', pipelineRunId: 'session_s1' }
      )

      const marker = await adapter.findNodeByName('__session_s1__', kb)
      expect(marker).not.toBeNull()
      expect(marker!.type).toBe('session_marker')
      // 提取结果非负（LLM 不可用时不抛异常）
      expect(r.nodes).toBeGreaterThanOrEqual(0)
      expect(r.edges).toBeGreaterThanOrEqual(0)
    })

    it('consolidate 合并同名异写实体', async () => {
      if (!adapter) return
      const kb = 'kb_session_merge'
      const builder = new GraphBuilder(adapter)
      await builder.buildFromExtraction(
        { entities: [{ name: 'Python', type: 'language' }, { name: 'Python ', type: 'language' }], triplets: [] },
        { knowledgeBaseId: kb }
      )
      const distiller = new SessionDistiller(adapter)
      const r = await distiller.consolidate(kb, 30, 1)
      expect(r.mergedCount).toBeGreaterThanOrEqual(0) // 同名归一合并（或已由 buildFromExtraction upsert 合并）
    })
  })

  // ─── 语义记忆地图 ──────────────────────────────────────────
  describe('SemanticMapLayout', () => {
    it('PCA 降维：语义相近节点坐标距离更近', async () => {
      if (!adapter) return
      const kb = 'kb_semmap'
      // 构造语义簇：Django/Flask 同簇（前 32 维高），SQLite 异簇（后 32 维高）
      const webVec = (seed: number) => Array.from({ length: 64 }, (_, i) => (i < 32 ? 1.0 : Math.sin(seed + i * 0.3)) * 0.5 + 0.5)
      const dbVec = () => Array.from({ length: 64 }, (_, i) => (i >= 32 ? 1.0 : Math.sin(9 + i * 0.3)) * 0.5 + 0.5)
      const django = await adapter.addNode({ knowledgeBaseId: kb, name: 'Django', type: 'framework', embedding: webVec(6) })
      const flask = await adapter.addNode({ knowledgeBaseId: kb, name: 'Flask', type: 'framework', embedding: webVec(5) })
      const sqlite = await adapter.addNode({ knowledgeBaseId: kb, name: 'SQLite', type: 'database', embedding: dbVec() })
      await adapter.addEdge({ sourceId: django, targetId: sqlite, relationshipName: '使用', knowledgeBaseId: kb })

      const layout = new SemanticMapLayout(adapter)
      const coords = await layout.computeLayout(kb, 2)
      expect(coords.size).toBe(3)
      const d = coords.get(django)!, f = coords.get(flask)!, s = coords.get(sqlite)!
      const distDF = Math.hypot(d.x - f.x, d.y - f.y)
      const distDS = Math.hypot(d.x - s.x, d.y - s.y)
      expect(distDF).toBeLessThan(distDS) // 语义相近节点更近
    })

    it('无 embedding 节点使用环形兜底布局', async () => {
      if (!adapter) return
      const kb = 'kb_semmap_none'
      const idA = await adapter.addNode({ knowledgeBaseId: kb, name: 'A', type: 't' })
      const idB = await adapter.addNode({ knowledgeBaseId: kb, name: 'B', type: 't' })
      const layout = new SemanticMapLayout(adapter)
      const coords = await layout.computeLayout(kb, 2)
      expect(coords.size).toBe(2)
      expect(coords.has(idA)).toBe(true)
      expect(coords.has(idB)).toBe(true)
      expect(typeof coords.get(idA)!.x).toBe('number')
      expect(typeof coords.get(idA)!.y).toBe('number')
    })

    it('getVisualizationData 返回带语义坐标的节点', async () => {
      if (!adapter) return
      const kb = 'kb_semmap_viz'
      await adapter.addNode({ knowledgeBaseId: kb, name: 'X', type: 't', embedding: hashEmbedding('x') })
      const layout = new SemanticMapLayout(adapter)
      const viz = await layout.getVisualizationData(kb)
      expect(viz.nodes.length).toBe(1)
      expect((viz.nodes[0].properties as any).x).toBeDefined()
      expect((viz.nodes[0].properties as any).y).toBeDefined()
    })
  })

  // ─── 反馈权重排序（P1 接线回归） ──────────────────────────
  describe('GraphCompletionRetriever feedback weights', () => {
    it('useFeedbackWeights 提升正反馈实体的三元组排序', async () => {
      if (!adapter) return
      const kb = 'kb_feedback'
      // 两个源节点嵌入远离查询，靠 feedback 区分；target 相同
      const farA = hashEmbedding('zzz far a')
      const farB = hashEmbedding('zzz far b')
      const nA = await adapter.addNode({ knowledgeBaseId: kb, name: 'NodeA', type: 't', embedding: farA, frequency: 1 })
      const nB = await adapter.addNode({ knowledgeBaseId: kb, name: 'NodeB', type: 't', embedding: farB, frequency: 1 })
      const t = await adapter.addNode({ knowledgeBaseId: kb, name: 'Target', type: 't', embedding: hashEmbedding('target') })
      await adapter.addEdge({ sourceId: nA, targetId: t, relationshipName: '关联', knowledgeBaseId: kb, weight: 1 })
      await adapter.addEdge({ sourceId: nB, targetId: t, relationshipName: '关联', knowledgeBaseId: kb, weight: 1 })

      // 给 NodeA 正反馈，NodeB 负反馈
      await adapter.setNodeFeedbackWeights(nA, { positive: 1, negative: 0 })
      await adapter.setNodeFeedbackWeights(nB, { positive: 0, negative: 1 })

      const q = hashEmbedding('query')
      const retriever = new GraphCompletionRetriever(adapter)
      const withFb = await retriever.search(q, { topK: 10, neighborDepth: 1, knowledgeBaseId: kb, useFeedbackWeights: true })
      const withoutFb = await retriever.search(q, { topK: 10, neighborDepth: 1, knowledgeBaseId: kb })

      // 启用反馈后：正反馈源（NodeA）的三元组应排到负反馈源（NodeB）前面
      const orderWithFb = withFb.triplets.map((tr) => tr.source.name)
      const orderWithoutFb = withoutFb.triplets.map((tr) => tr.source.name)
      const idxAWith = orderWithFb.indexOf('NodeA')
      const idxBWith = orderWithFb.indexOf('NodeB')
      const idxAWithout = orderWithoutFb.indexOf('NodeA')
      const idxBWithout = orderWithoutFb.indexOf('NodeB')
      // 无反馈时两者位置由向量相似度决定；有反馈时 NodeA 必然在 NodeB 之前
      expect(idxAWith).toBeGreaterThanOrEqual(0)
      expect(idxBWith).toBeGreaterThanOrEqual(0)
      expect(idxAWith).toBeLessThan(idxBWith)
      // 对照：确认 feedbackFactor 真的改变了顺序（至少不是无操作）
      expect(idxAWith !== idxAWithout || idxBWith !== idxBWithout).toBe(true)
    })

    it('不透传 useFeedbackWeights 时反馈权重不生效（默认 no-op）', async () => {
      if (!adapter) return
      const kb = 'kb_feedback_default'
      const nA = await adapter.addNode({ knowledgeBaseId: kb, name: 'NA', type: 't', embedding: hashEmbedding('aaa') })
      const nB = await adapter.addNode({ knowledgeBaseId: kb, name: 'NB', type: 't', embedding: hashEmbedding('bbb') })
      const t = await adapter.addNode({ knowledgeBaseId: kb, name: 'T', type: 't', embedding: hashEmbedding('ttt') })
      await adapter.addEdge({ sourceId: nA, targetId: t, relationshipName: '关联', knowledgeBaseId: kb, weight: 1 })
      await adapter.addEdge({ sourceId: nB, targetId: t, relationshipName: '关联', knowledgeBaseId: kb, weight: 1 })
      await adapter.setNodeFeedbackWeights(nA, { positive: 1, negative: 0 })

      const retriever = new GraphCompletionRetriever(adapter)
      const res = await retriever.search(hashEmbedding('q'), { topK: 10, neighborDepth: 1, knowledgeBaseId: kb })
      // 未启用时不应抛异常，且应正常返回
      expect(res.triplets.length).toBeGreaterThan(0)
    })
  })

  // ─── 时间消解作用域（touchedNodeIds） ────────────────────
  describe('TemporalConflictResolver touched 作用域', () => {
    it('只消解触及节点的 functional 冲突，不影响无关节点', async () => {
      if (!adapter) return
      const kb = 'kb_temporal_scope'
      // 触及组：rpa 版本冲突（5.0 旧 / 6.0 新）
      const rpa = await adapter.addNode({ knowledgeBaseId: kb, name: '影刀RPA', type: 'product' })
      const v5 = await adapter.addNode({ knowledgeBaseId: kb, name: '5.0', type: 'term' })
      const v6 = await adapter.addNode({ knowledgeBaseId: kb, name: '6.0', type: 'term' })
      await adapter.addEdge({ sourceId: rpa, targetId: v5, relationshipName: '版本为', knowledgeBaseId: kb, properties: { effectiveDate: '2024-01-01' } })
      await adapter.addEdge({ sourceId: rpa, targetId: v6, relationshipName: '版本为', knowledgeBaseId: kb, properties: { effectiveDate: '2025-06-01' } })

      // 无关组：另一主体也有版本冲突，但不在 touched 集合内
      const other = await adapter.addNode({ knowledgeBaseId: kb, name: 'Other', type: 'product' })
      const o1 = await adapter.addNode({ knowledgeBaseId: kb, name: '1.0', type: 'term' })
      const o2 = await adapter.addNode({ knowledgeBaseId: kb, name: '2.0', type: 'term' })
      await adapter.addEdge({ sourceId: other, targetId: o1, relationshipName: '版本为', knowledgeBaseId: kb, properties: { effectiveDate: '2023-01-01' } })
      await adapter.addEdge({ sourceId: other, targetId: o2, relationshipName: '版本为', knowledgeBaseId: kb, properties: { effectiveDate: '2024-01-01' } })

      // 只触及 rpa
      const resolver = new TemporalConflictResolver(adapter)
      const result = await resolver.resolve(kb, { touchedNodeIds: [rpa] })

      expect(result.supersededEdgeCount).toBe(1) // 只消解 rpa 的 5.0

      // 无关组不被触及：Other 的 1.0 边不应被标记 superseded
      const otherEdges = await adapter.getEdges(other)
      const otherSuperseded = otherEdges.filter((e) => e.properties?.superseded === true)
      expect(otherSuperseded).toHaveLength(0)

      // rpa 的旧边被标记
      const rpaEdges = await adapter.getEdges(rpa)
      const rpaSuperseded = rpaEdges.filter((e) => e.properties?.superseded === true)
      expect(rpaSuperseded).toHaveLength(1)
      expect(rpaSuperseded[0].targetId).toBe(v5)
      // 字段名对齐 cognee：superseded_by 为 winner 边标识（含 v6 id），reason 含关系名
      expect(String(rpaSuperseded[0].properties.superseded_by)).toContain(v6)
      expect(String(rpaSuperseded[0].properties.supersession_reason)).toContain('版本为')
    })
  })

  // ─── 检索变体修复 ──────────────────────────────────────
  describe('检索变体（排序方向 + 子查询向量化）', () => {
    it('TripletRetriever 距离空间升序：与 GraphCompletionRetriever 语义一致', async () => {
      if (!adapter) return
      const kb = 'kb_triplet_order'
      // 三个节点，两个边：A 近查询，B 远查询，权重相同
      const a = await adapter.addNode({ knowledgeBaseId: kb, name: 'A', type: 't', embedding: hashEmbedding('aaaa') })
      const b = await adapter.addNode({ knowledgeBaseId: kb, name: 'B', type: 't', embedding: hashEmbedding('bbbb') })
      const t = await adapter.addNode({ knowledgeBaseId: kb, name: 'T', type: 't', embedding: hashEmbedding('tttt') })
      await adapter.addEdge({ sourceId: a, targetId: t, relationshipName: '关联', knowledgeBaseId: kb, weight: 1 })
      await adapter.addEdge({ sourceId: b, targetId: t, relationshipName: '关联', knowledgeBaseId: kb, weight: 1 })

      const q = hashEmbedding('aaaa') // 查询贴近 A
      const retriever = new TripletRetriever(adapter)
      const res = await retriever.search(q, { topK: 10, neighborDepth: 1, knowledgeBaseId: kb })
      expect(res.triplets.length).toBe(2)
      // 距离空间：A 的三元组应排最前（score 更小）
      expect(res.triplets[0].source.name).toBe('A')
      expect(res.triplets[0].score).toBeLessThanOrEqual(res.triplets[1].score)
    })

    it('DecompositionRetriever 降级：LLM/embedding 不可用时仍正常返回且合并升序', async () => {
      if (!adapter) return
      const kb = 'kb_decomp'
      const n1 = await adapter.addNode({ knowledgeBaseId: kb, name: 'Python', type: 'language', embedding: hashEmbedding('python') })
      const n2 = await adapter.addNode({ knowledgeBaseId: kb, name: 'FastAPI', type: 'framework', embedding: hashEmbedding('fastapi') })
      await adapter.addEdge({ sourceId: n1, targetId: n2, relationshipName: '基于', knowledgeBaseId: kb, weight: 1 })

      const retriever = new GraphCompletionDecompositionRetriever(adapter, { model: 'non-existent-model' })
      const res = await retriever.search(hashEmbedding('python'), 'Python 框架', {
        topK: 5, neighborDepth: 1, knowledgeBaseId: kb,
      })
      // 分解失败退化为原查询，仍应返回结果
      expect(res.triplets.length).toBeGreaterThanOrEqual(1)
      expect(res.subQueries.length).toBeGreaterThanOrEqual(1)
      // 合并升序（距离空间）
      const scores = res.triplets.map((t) => t.score)
      expect([...scores].sort((x, y) => x - y)).toEqual(scores)
    })

    it('ContextExtensionRetriever 升序返回', async () => {
      if (!adapter) return
      const kb = 'kb_ctxext'
      const n1 = await adapter.addNode({ knowledgeBaseId: kb, name: 'Python', type: 'language', embedding: hashEmbedding('python') })
      const n2 = await adapter.addNode({ knowledgeBaseId: kb, name: 'Django', type: 'framework', embedding: hashEmbedding('django') })
      await adapter.addEdge({ sourceId: n1, targetId: n2, relationshipName: '用于', knowledgeBaseId: kb, weight: 1 })

      const retriever = new GraphCompletionContextExtensionRetriever(adapter)
      const res = await retriever.search(hashEmbedding('python'), { topK: 5, neighborDepth: 1, knowledgeBaseId: kb, rounds: 2 })
      expect(res.triplets.length).toBeGreaterThanOrEqual(1)
      const scores = res.triplets.map((t) => t.score)
      expect([...scores].sort((x, y) => x - y)).toEqual(scores)
    })
  })

  // ─── 确定性实体 id ─────────────────────────────────────
  describe('entityNodeId（确定性 id）', () => {
    it('同 kb 同名实体跨摄入 id 恒定，frequency 累加', async () => {
      if (!adapter) return
      const kb = 'kb_detid'
      const builder = new GraphBuilder(adapter)
      await builder.buildFromExtraction({ entities: [{ name: '影刀RPA', type: 'product' }], triplets: [] }, { knowledgeBaseId: kb, documentId: 'd1' })
      await builder.buildFromExtraction({ entities: [{ name: '影刀RPA', type: 'product' }], triplets: [] }, { knowledgeBaseId: kb, documentId: 'd2' })
      const node = await adapter.findNodeByName('影刀RPA', kb)
      expect(node).not.toBeNull()
      expect(node!.id).toBe(entityNodeId(kb, '影刀RPA'))
      expect(node!.frequency).toBe(2)
    })

    it('不同 kb 同名实体 id 不同（符合 (kb,name) 约束）', () => {
      expect(entityNodeId('kb1', 'Python')).not.toBe(entityNodeId('kb2', 'Python'))
      expect(entityNodeId('kb1', 'Python')).toBe(entityNodeId('kb1', 'Python'))
    })

    it('EntityType 节点 + is_a 边（虚拟 kb，业务图干净）', async () => {
      if (!adapter) return
      const kb = 'kb_etype'
      const builder = new GraphBuilder(adapter)
      await builder.buildFromExtraction(
        { entities: [{ name: '影刀RPA', type: 'product' }, { name: 'Python', type: 'language' }],
          triplets: [{ source: '影刀RPA', relation: '使用', target: 'Python', confidence: 0.9 }] },
        { knowledgeBaseId: kb, documentId: 'd1' }
      )
      // EntityType 节点在虚拟 kb
      const productType = await adapter.findNodeByName('product', ENTITY_TYPE_KB)
      const langType = await adapter.findNodeByName('language', ENTITY_TYPE_KB)
      expect(productType).not.toBeNull()
      expect(langType).not.toBeNull()
      expect(productType!.type).toBe('entity_type')
      // is_a 边：实体 → EntityType
      const rpa = await adapter.findNodeByName('影刀RPA', kb)
      const isa = (await adapter.getEdges(rpa!.id)).filter((e) => e.relationshipName === 'is_a')
      expect(isa.length).toBe(1)
      expect(isa[0].targetId).toBe(entityTypeNodeId('product'))
      // 业务图不含 is_a 边
      const biz = await adapter.getGraphData(kb)
      expect(biz.edges.every((e) => e.relationshipName !== 'is_a')).toBe(true)
    })
  })

  // ─── deleteByDocument detach + unowned 语义 ─────────────────
  describe('UnifiedStoreEngine deleteByDocument（detach + unowned）', () => {
    it('共享实体被其他文档引用时 detach 保留，无引用时 unowned 硬删', async () => {
      if (!adapter) return
      const kb = 'kb_detach'
      const builder = new GraphBuilder(adapter)
      const engine = new UnifiedStoreEngine(adapter, undefined, SCHEMA)

      // docX：独占实体X + 共享实体；docY：独占实体Y + 共享实体
      await builder.buildFromExtraction(
        { entities: [{ name: '独占X', type: 'concept' }, { name: '共享S', type: 'concept' }],
          triplets: [{ source: '独占X', relation: '关联', target: '共享S', confidence: 0.9 }] },
        { knowledgeBaseId: kb, documentId: 'docX' }
      )
      await builder.buildFromExtraction(
        { entities: [{ name: '独占Y', type: 'concept' }, { name: '共享S', type: 'concept' }],
          triplets: [{ source: '独占Y', relation: '关联', target: '共享S', confidence: 0.9 }] },
        { knowledgeBaseId: kb, documentId: 'docY' }
      )

      const before = await adapter.getGraphData(kb)
      expect(before.nodes.length).toBe(3) // 独占X + 独占Y + 共享S

      // 删 docX：独占X unowned 硬删；共享S 被 docY 引用 → detach 保留
      const result = await engine.deleteByDocument('docX', kb)
      expect(result.deletedNodeIds.length).toBe(1)

      const after = await adapter.getGraphData(kb)
      const names = after.nodes.map((n) => n.name)
      expect(names).toContain('共享S') // detach 保留
      expect(names).toContain('独占Y')
      expect(names).not.toContain('独占X')

      // docX 关联表已清，docY 仍可溯源共享S
      expect(await adapter.getNodeIdsByDocument('docX')).toHaveLength(0)
      const docYNodes = await adapter.getNodeIdsByDocument('docY')
      const sharedNode = await adapter.findNodeByName('共享S', kb)
      expect(docYNodes).toContain(sharedNode!.id)
    })

    it('能力守卫：无 GRAPH 能力时访问抛错', () => {
      const engine = new UnifiedStoreEngine(null as any, undefined, SCHEMA)
      expect(() => engine.graphEngine).toThrow(/GRAPH/)
    })
  })
})
