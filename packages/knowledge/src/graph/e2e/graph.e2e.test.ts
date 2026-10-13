/**
 * 图能力端到端（E2E）测试
 *
 * 与单元测试的区别：每个用例走完整业务流（摄入 → 构建 → 处理 → 检索/消费 → 清理），
 * 验证多组件协作的正确性，而非单点行为。
 *
 * LLM 代理可用时走真实提取；不可用时降级为确定性数据，流程断言不变。
 * 运行：DATABASE_URL="postgresql://test:test123@localhost:5433/graph_test" \
 *       npx vitest run src/graph/e2e/
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { Pool } from 'pg'
import { PgGraphAdapter } from '../pg-adapter/adapter.js'
import { GraphBuilder } from '../extraction/graph-builder.js'
import { EntityExtractor } from '../extraction/entity-extractor.js'
import { EntityConsolidator } from '../algorithms/entity-consolidator.js'
import { TemporalConflictResolver, filterActiveEdges } from '../algorithms/temporal-conflict-resolver.js'
import { ContradictionDetector } from '../algorithms/contradiction-detector.js'
import { EdgeTypeIndexer } from '../algorithms/edge-type-indexer.js'
import { GraphCompletionRetriever } from '../retrieval/graph-completion-retriever.js'
import { TemporalRetriever, TripletRetriever } from '../retrieval/retriever-variants.js'
import { GraphVisualizer } from '../visualization/index.js'
import { RdfExporter } from '../visualization/rdf-export.js'
import { UnifiedStoreEngine } from '../unified/engine.js'
import { OntologyValidator, DEFAULT_ONTOLOGY } from '../ontology/index.js'
import { CodeGraphExtractor } from '../extraction/code-graph-extractor.js'
import type { CombinedExtraction } from '../types.js'

const SCHEMA = 'test_e2e'

/** LLM 可用则真实提取，不可用则确定性降级（不影响流程断言） */
async function extract(text: string, ontologyText?: string): Promise<CombinedExtraction> {
  try {
    const e = new EntityExtractor({ maxRetries: 0 })
    const r = await e.extract(text, { ontologyText })
    if (r.entities.length > 0) return r
  } catch { /* 代理不可用 → 降级 */ }
  return { entities: [], triplets: [] }
}

/** 确定性嵌入：同文本同向量，相近文本给相近向量由调用方构造 */
function emb(seed: number, dim = 64): number[] {
  return Array.from({ length: dim }, (_, i) => Math.sin(seed + i * 0.7) * 0.5 + 0.5)
}

describe.skipIf(!process.env.DATABASE_URL)('图能力 E2E', () => {
  let pool: Pool
  let adapter: PgGraphAdapter

  beforeAll(async () => {
    const cs = process.env.DATABASE_URL || ''
    if (!cs) throw new Error('需要 DATABASE_URL（本地库）')
    pool = new Pool({ connectionString: cs })
    adapter = new PgGraphAdapter(pool, SCHEMA, 64)
    await adapter.init()
  })

  afterAll(async () => {
    await adapter.deleteGraph()
    await pool.end()
  })

  // ============================================================
  it('E2E-1 全链路：两份文档 → 图谱构建 → 图补全检索返回跨文档关联', async () => {
    const kb = 'e2e_full'
    const builder = new GraphBuilder(adapter)

    // 文档 1（真实 LLM 或降级数据；降级时仍写入等价结构验证流程）
    let d1 = await extract('Django 是一个 Python Web 框架。Python 是一门编程语言。')
    if (d1.entities.length === 0) {
      d1 = {
        entities: [
          { name: 'Django', type: 'technology' },
          { name: 'Python', type: 'language' },
        ],
        triplets: [{ source: 'Django', relation: '基于', target: 'Python', confidence: 0.9 }],
      }
    }
    const r1 = await builder.buildFromExtraction(d1, { knowledgeBaseId: kb, documentId: 'doc1' })

    // 文档 2：与文档 1 共享实体 Python
    let d2 = await extract('FastAPI 也是一个 Python Web 框架。')
    if (d2.entities.length === 0) {
      d2 = {
        entities: [
          { name: 'FastAPI', type: 'technology' },
          { name: 'Python', type: 'language' },
        ],
        triplets: [{ source: 'FastAPI', relation: '基于', target: 'Python', confidence: 0.9 }],
      }
    }
    const r2 = await builder.buildFromExtraction(d2, { knowledgeBaseId: kb, documentId: 'doc2' })

    // 断言：共享实体 Python 被 upsert（frequency ≥ 2），溯源关联表有两条文档记录
    const python = await adapter.findNodeByName('Python', kb)
    expect(python).not.toBeNull()
    expect(python!.frequency).toBeGreaterThanOrEqual(2)
    const doc1Nodes = await adapter.getNodeIdsByDocument('doc1')
    const doc2Nodes = await adapter.getNodeIdsByDocument('doc2')
    expect(doc1Nodes.length).toBeGreaterThan(0)
    expect(doc2Nodes.length).toBeGreaterThan(0)

    // 检索：图补全应返回两份文档的三元组（跨文档经由 Python 关联）
    const retriever = new GraphCompletionRetriever(adapter)
    const result = await retriever.search(emb(1), { topK: 10, neighborDepth: 2, knowledgeBaseId: kb })
    expect(result.triplets.length).toBeGreaterThanOrEqual(2)
    const rels = result.triplets.map((t) => `${t.source.name}→${t.target.name}`)
    expect(rels.some((r) => r.includes('Python'))).toBe(true)
    void r1; void r2
  })

  // ============================================================
  it('E2E-2 去重闭环：两文档同名异写实体 → 合并 → 边迁移 → 图中唯一', async () => {
    const kb = 'e2e_dedup'
    const builder = new GraphBuilder(adapter)

    // 文档 A：影刀RPA（全称）；文档 B：影刀 RPA（多空格异写）
    await builder.buildFromExtraction(
      {
        entities: [
          { name: '影刀RPA', type: 'product' },
          { name: '定时触发', type: 'feature' },
        ],
        triplets: [{ source: '影刀RPA', relation: '支持', target: '定时触发', confidence: 0.9 }],
      },
      { knowledgeBaseId: kb, documentId: 'docA' }
    )
    await builder.buildFromExtraction(
      {
        entities: [
          { name: '影刀 RPA', type: 'product' },
          { name: 'Excel处理', type: 'feature' },
        ],
        triplets: [{ source: '影刀 RPA', relation: '支持', target: 'Excel处理', confidence: 0.9 }],
      },
      { knowledgeBaseId: kb, documentId: 'docB' }
    )

    // 合并前：两个异写节点各有一条边
    const consolidator = new EntityConsolidator(adapter)
    const dry = await consolidator.consolidate({ knowledgeBaseId: kb, dryRun: true })
    expect(dry.candidates.length).toBe(1) // 同名归一命中（空格被 strip）
    expect(dry.candidates[0].reason).toBe('same_normalized_name')

    const merged = await consolidator.consolidate({ knowledgeBaseId: kb })
    expect(merged.mergedCount).toBe(1)

    // 闭环断言：主节点承接全部边，重复节点消失
    const primary = await adapter.findNodeByName('影刀RPA', kb)
    expect(primary).not.toBeNull()
    const edges = await adapter.getEdges(primary!.id)
    // 2 条业务边（定时触发 + Excel处理）+ 可能的 is_a 类型边（对齐 cognee EntityType 体系）
    const businessEdges = edges.filter((e) => e.relationshipName !== 'is_a')
    expect(businessEdges.length).toBe(2)
    expect(businessEdges.some((e) => e.targetId !== primary!.id)).toBe(true)
    expect(await adapter.findNodeByName('影刀 RPA', kb)).toBeNull()
  })

  // ============================================================
  it('E2E-3 时间线闭环：事件入库 → functional 冲突消解 → 时间过滤检索', async () => {
    const kb = 'e2e_temporal'
    const builder = new GraphBuilder(adapter)

    // 旧版本断言：影刀RPA 版本为 5.0
    await builder.buildFromExtraction(
      {
        entities: [
          { name: '影刀RPA', type: 'product' },
          { name: '5.0', type: 'term' },
        ],
        triplets: [{ source: '影刀RPA', relation: '版本为', target: '5.0', confidence: 0.9 }],
      },
      { knowledgeBaseId: kb, documentId: 'old_doc' }
    )
    // 手工为旧边盖 effectiveDate（buildFromExtraction 不透传日期属性，此处直接补写）
    const rpaNode = await adapter.findNodeByName('影刀RPA', kb)
    const v5 = await adapter.findNodeByName('5.0', kb)
    await adapter.deleteEdge(rpaNode!.id, v5!.id, '版本为')
    await adapter.addEdge({
      sourceId: rpaNode!.id, targetId: v5!.id, relationshipName: '版本为',
      knowledgeBaseId: kb, weight: 0.9,
      properties: { effectiveDate: '2024-01-01', sourceDocumentId: 'old_doc' },
    })

    // 新版本断言：影刀RPA 版本为 6.0（更晚的 effectiveDate）
    await builder.buildFromExtraction(
      {
        entities: [
          { name: '影刀RPA', type: 'product' },
          { name: '6.0', type: 'term' },
        ],
        triplets: [{ source: '影刀RPA', relation: '版本为', target: '6.0', confidence: 0.9 }],
      },
      { knowledgeBaseId: kb, documentId: 'new_doc' }
    )
    const v6 = await adapter.findNodeByName('6.0', kb)
    await adapter.deleteEdge(rpaNode!.id, v6!.id, '版本为')
    await adapter.addEdge({
      sourceId: rpaNode!.id, targetId: v6!.id, relationshipName: '版本为',
      knowledgeBaseId: kb, weight: 0.9,
      properties: { effectiveDate: '2025-06-01', sourceDocumentId: 'new_doc' },
    })

    // 消解：旧版本边应被标记 superseded
    const resolver = new TemporalConflictResolver(adapter)
    const resolved = await resolver.resolve(kb)
    expect(resolved.supersededEdgeCount).toBe(1)

    // 闭环断言：检索侧只见当前版本
    const allEdges = await adapter.getEdges(rpaNode!.id)
    const activeVersionEdges = filterActiveEdges(
      allEdges.filter((e) => e.relationshipName === '版本为')
    )
    expect(activeVersionEdges).toHaveLength(1)
    expect(activeVersionEdges[0].targetId).toBe(v6!.id)

    // 时间过滤检索
    const retriever = new TemporalRetriever(adapter)
    const result = await retriever.search(emb(2), {
      topK: 10, neighborDepth: 2, knowledgeBaseId: kb, after: '2025-01-01',
    })
    expect(result.context).toContain('6.0')
    expect(result.context).not.toContain('5.0') // 失效断言不出现
  })

  // ============================================================
  it('E2E-4 删除闭环：deleteByDocument 清理图 + 关联表 + 检索恢复为空', async () => {
    const kb = 'e2e_delete'
    const builder = new GraphBuilder(adapter)
    const engine = new UnifiedStoreEngine(adapter, undefined, SCHEMA)

    // 文档 X 与文档 Y 共享一个实体；删 X 后共享实体若只被 X 引用应被清理
    await builder.buildFromExtraction(
      {
        entities: [
          { name: '独占实体X', type: 'concept' },
          { name: '桥接实体', type: 'concept' },
        ],
        triplets: [{ source: '独占实体X', relation: '关联', target: '桥接实体', confidence: 0.9 }],
      },
      { knowledgeBaseId: kb, documentId: 'docX' }
    )
    await builder.buildFromExtraction(
      {
        entities: [
          { name: '独占实体Y', type: 'concept' },
          { name: '桥接实体', type: 'concept' },
        ],
        triplets: [{ source: '独占实体Y', relation: '关联', target: '桥接实体', confidence: 0.9 }],
      },
      { knowledgeBaseId: kb, documentId: 'docY' }
    )

    const before = await adapter.getGraphData(kb)
    expect(before.nodes.length).toBe(3)

    // 按文档删除 X（detach + unowned 语义，对标 cognee provenance_delete_planner）
    const result = await engine.deleteByDocument('docX', kb)
    // 独占实体X 是 unowned（只被 docX 引用）→ 硬删；桥接实体被 docY 也引用 → detach 保留
    expect(result.deletedNodeIds.length).toBe(1)
    expect(result.deletedEdgeCount).toBeGreaterThanOrEqual(1)

    // 闭环断言：关联表清理、共享实体保留、图剩 Y 相关（独占实体Y + 桥接实体）
    const remaining = await adapter.getGraphData(kb)
    const remainingNames = remaining.nodes.map((n) => n.name)
    expect(remainingNames).toContain('独占实体Y')
    expect(remainingNames).toContain('桥接实体')
    expect(remainingNames).not.toContain('独占实体X')
    expect(remaining.nodes.length).toBe(2)
    const links = await adapter.getNodeIdsByDocument('docX')
    expect(links).toHaveLength(0)

    // 桥接实体仍可被 docY 溯源
    const bridgeY = await adapter.getNodeIdsByDocument('docY')
    expect(bridgeY.length).toBeGreaterThanOrEqual(1)

    // 检索仍有 Y 关联边（桥接实体保留 → 边存在）
    const retriever = new TripletRetriever(adapter)
    const search = await retriever.search(emb(3), { topK: 5, neighborDepth: 1, knowledgeBaseId: kb })
    expect(search.triplets.length).toBeGreaterThanOrEqual(1)
  })

  // ============================================================
  it('E2E-5 本体闭环：本体注入提取 → 违规过滤 → 图中只存在合规类型', async () => {
    const kb = 'e2e_onto'
    const validator = new OntologyValidator(DEFAULT_ONTOLOGY)
    const builder = new GraphBuilder(adapter)

    // 模拟 LLM 输出（含违规项）：未定义类型 + 不允许的关系端
    const rawExtraction: CombinedExtraction = {
      entities: [
        { name: '影刀RPA', type: 'product' },
        { name: 'Python', type: 'language' },
        { name: '神秘物体', type: 'alien_artifact' }, // 违规类型
        { name: '张三', type: 'person' },
      ],
      triplets: [
        { source: '影刀RPA', relation: '使用', target: 'Python', confidence: 0.9 }, // 合规
        { source: '影刀RPA', relation: '包含', target: 'Python', confidence: 0.9 }, // 违规：product 不允许发包含
        { source: '张三', relation: '使用', target: 'Python', confidence: 0.9 }, // 合规
      ],
    }

    const validated = validator.validate(rawExtraction)
    expect(validated.valid).toBe(false)
    expect(validated.violations.length).toBeGreaterThanOrEqual(2)
    expect(validated.filtered.entities).toHaveLength(3) // alien_artifact 被滤
    expect(validated.filtered.triplets).toHaveLength(2) // 包含被滤

    // 只写入合规部分
    await builder.buildFromExtraction(validated.filtered, { knowledgeBaseId: kb })

    // 闭环断言：图中无违规类型节点，无边类型"包含"
    const data = await adapter.getGraphData(kb)
    expect(data.nodes.every((n) => n.type !== 'alien_artifact')).toBe(true)
    expect(data.edges.every((e) => e.relationshipName !== '包含')).toBe(true)
    expect(data.nodes.length).toBe(3)
    expect(data.edges.length).toBe(2)
  })

  // ============================================================
  it('E2E-6 代码图闭环：源文件 → 提取 → 依赖查询 → 反向影响分析', async () => {
    const kb = 'e2e_code'
    const extractor = new CodeGraphExtractor(adapter)

    const result = await extractor.extractFromFiles(
      [
        {
          path: 'src/services/adapter.ts',
          content: `import { Pool } from 'pg'\nimport { Logger } from '../utils/logger'\n\nexport class DbAdapter {}\nexport function connect() {}`,
        },
        {
          path: 'src/handlers/api.ts',
          content: `import { DbAdapter, connect } from '../services/adapter'\n\nexport async function handle() {}`,
        },
      ],
      { knowledgeBaseId: kb, repositoryName: 'e2e-repo' }
    )

    // 提取断言
    expect(result.filesProcessed).toBe(2)
    expect(result.nodes).toBeGreaterThanOrEqual(7) // repo + 2 file + class + 2 fn + 外部模块

    // 闭环查询 1：api.ts 依赖模块节点（import 路径字符串）
    const api = await adapter.findNodeByName('src/handlers/api.ts', kb)
    const adapterClass = await adapter.findNodeByName('DbAdapter', kb)
    expect(api).not.toBeNull()
    expect(adapterClass).not.toBeNull()
    const neighbors = await adapter.getNeighbors(api!.id)
    const neighborNames = neighbors.map((nb) => nb.node.name)
    expect(neighborNames).toContain('../services/adapter') // depends_on → 模块节点
    expect(neighborNames).toContain('handle') // contains → 导出函数

    // 闭环查询 2：反向影响分析——DbAdapter 类节点属于哪个文件（contains 反向）
    const impacted = await adapter.getNeighbors(adapterClass!.id)
    const impactedFiles = impacted.map((nb) => nb.node.name).filter((n) => n.endsWith('.ts'))
    expect(impactedFiles).toContain('src/services/adapter.ts')
  })

  // ============================================================
  it('E2E-7 NodeSet + EdgeType 闭环：打标签 → 圈选子图 → 边类型统计', async () => {
    const kb = 'e2e_set'
    const builder = new GraphBuilder(adapter)
    const indexer = new EdgeTypeIndexer(adapter)

    // 两组主题数据
    const r1 = await builder.buildFromExtraction(
      {
        entities: [{ name: 'AI', type: 'concept' }, { name: 'FinTech', type: 'concept' }],
        triplets: [{ source: 'AI', relation: '赋能', target: 'FinTech', confidence: 0.9 }],
      },
      { knowledgeBaseId: kb }
    )
    const r2 = await builder.buildFromExtraction(
      {
        entities: [{ name: 'MedTech', type: 'concept' }],
        triplets: [],
      },
      { knowledgeBaseId: kb }
    )
    await indexer.tagNodesWithSet(r1.nodeIds, 'AI_FinTech')
    await indexer.tagNodesWithSet(r2.nodeIds, 'MedTech')

    // 圈选：AI 组只含 2 节点；业务边 1 条（赋能），is_a 类型边不计入业务语义
    const aiSub = await adapter.getSubgraphByNodeSetLabel('AI_FinTech', kb)
    expect(aiSub.nodes.length).toBe(2)
    const aiBusinessEdges = aiSub.edges.filter((e) => e.relationshipName !== 'is_a')
    expect(aiBusinessEdges.length).toBe(1)

    // 边类型统计
    await indexer.refresh(kb)
    const types = await indexer.listEdgeTypes()
    expect(types.find((t) => t.name === '赋能')?.count).toBe(1)
  })

  // ============================================================
  it('E2E-8 可视化 + RDF 导出闭环：同一图两种消费形态', async () => {
    const kb = 'e2e_viz'
    const builder = new GraphBuilder(adapter)

    await builder.buildFromExtraction(
      {
        entities: [{ name: 'Python', type: 'language' }, { name: 'FastAPI', type: 'technology' }],
        triplets: [{ source: 'FastAPI', relation: '基于', target: 'Python', confidence: 0.9 }],
      },
      { knowledgeBaseId: kb }
    )

    // 可视化数据形态
    const visualizer = new GraphVisualizer(adapter)
    const viz = await visualizer.getVisualizationData(kb)
    expect(viz.nodes.map((n) => n.label).sort()).toEqual(['FastAPI', 'Python'])
    expect(viz.edges[0].label).toBe('基于')

    // RDF 形态：Turtle 含类型与谓词
    const exporter = new RdfExporter(adapter)
    const turtle = await exporter.exportToTurtle({ knowledgeBaseId: kb })
    expect(turtle).toContain('rdf:type :Language')
    expect(turtle).toContain(':基于')
    const ntriples = await exporter.exportToNTriples({ knowledgeBaseId: kb })
    expect(ntriples.some((t) => t.includes('%E5%9F%BA%E4%BA%8E') || t.includes('基于'))).toBe(true)
  })

  // ============================================================
  it('E2E-9 矛盾检测闭环：矛盾图 → 检测（LLM 降级纯规则）→ contradicts 可追溯', async () => {
    const kb = 'e2e_contra'
    const builder = new GraphBuilder(adapter)

    // 构造规则矛盾：A 支持 B 且 A 不支持 B
    await builder.buildFromExtraction(
      {
        entities: [
          { name: 'Chrome', type: 'product' },
          { name: 'ActiveX', type: 'technology' },
        ],
        triplets: [
          { source: 'Chrome', relation: '支持', target: 'ActiveX', confidence: 0.8 },
          { source: 'Chrome', relation: '不支持', target: 'ActiveX', confidence: 0.9 },
        ],
      },
      { knowledgeBaseId: kb }
    )

    // LLM 传 null 强制纯规则路径（代理不可用时生产也是这个行为）
    const detector = new ContradictionDetector(adapter, { model: null as any })
    const result = await detector.detect(kb)

    expect(result.contradictions.length).toBeGreaterThanOrEqual(1)
    const c = result.contradictions[0]
    expect(c.sourceNode.name).toBe('Chrome')
    expect([c.relation1, c.relation2].sort()).toEqual(['不支持', '支持'])
    expect(c.confidence).toBeGreaterThan(0)
  })
})
