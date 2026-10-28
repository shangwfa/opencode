import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Pool } from 'pg'
import { PgGraphAdapter } from './pg-adapter/adapter.js'
import { TemporalConflictResolver, filterActiveEdges } from './algorithms/temporal-conflict-resolver.js'
import { RdfExporter } from './visualization/rdf-export.js'
import { resolveTripletsToText, generateTitleFromTriplets, formatTripletsAsContext } from './utils/resolve-edges-to-text.js'
import { CodeGraphExtractor } from './extraction/code-graph-extractor.js'
import type { Triplet } from './types.js'

const TEST_SCHEMA = 'test_gaps'

// ---------- 纯单元测试（无数据库） ----------

describe('TemporalConflictResolver (unit)', () => {
  it('filterActiveEdges 应过滤 superseded 边', () => {
    const edges = [
      { properties: {}, weight: 1 } as any,
      { properties: { superseded: true }, weight: 1 } as any,
      { properties: { superseded: false }, weight: 1 } as any,
    ]
    expect(filterActiveEdges(edges)).toHaveLength(2)
  })
})

describe('RdfExporter (unit with mock)', () => {
  it('应导出 Turtle 格式', async () => {
    const mockGraph = {
      getGraphData: async () => ({
        nodes: [
          { id: 'n1', knowledgeBaseId: 'kb', name: 'Python', type: 'language', properties: { version: '3.12' }, frequency: 1, createdAt: new Date(), updatedAt: new Date() },
        ],
        edges: [
          { sourceId: 'n1', targetId: 'n1', relationshipName: 'self_ref', properties: {}, weight: 0.5, knowledgeBaseId: 'kb', createdAt: new Date(), updatedAt: new Date() },
        ],
      }),
    } as any

    const exporter = new RdfExporter(mockGraph)
    const turtle = await exporter.exportToTurtle()
    expect(turtle).toContain('@prefix')
    expect(turtle).toContain('rdf:type :Language')
    expect(turtle).toContain('"Python"')
    expect(turtle).toContain(':self_ref')

    const ntriples = await exporter.exportToNTriples()
    expect(ntriples.some((t) => t.includes('#type'))).toBe(true)
  })
})

describe('resolve-edges-to-text (unit)', () => {
  const makeTriplet = (s: string, r: string, t: string): Triplet => ({
    source: { id: '1', knowledgeBaseId: 'kb', name: s, type: 'entity', properties: {}, frequency: 1, createdAt: new Date(), updatedAt: new Date() },
    relation: r,
    target: { id: '2', knowledgeBaseId: 'kb', name: t, type: 'entity', properties: {}, frequency: 1, createdAt: new Date(), updatedAt: new Date() },
    weight: 1,
    score: 1,
  })

  it('resolveTripletsToText 应生成可读文本', () => {
    const text = resolveTripletsToText([makeTriplet('Python', '用于', 'AI开发')])
    expect(text).toBe('Python 用于 AI开发')
  })

  it('generateTitleFromTriplets 应取高频实体', () => {
    const title = generateTitleFromTriplets([
      makeTriplet('Python', '用于', 'AI'),
      makeTriplet('Python', '属于', '语言'),
    ])
    expect(title.startsWith('Python')).toBe(true)
  })

  it('formatTripletsAsContext 应含标题', () => {
    const ctx = formatTripletsAsContext([makeTriplet('A', 'rel', 'B')])
    expect(ctx).toMatch(/^【/)
  })
})

// ---------- 集成测试（本地数据库） ----------

describe('Gaps 集成测试', () => {
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

  it('embedding 写入与读取（Bug 修复验证）', async () => {
    if (!adapter) return
    const emb = [0.1, 0.2, 0.3, 0.4]
    const id = await adapter.addNode({
      knowledgeBaseId: 'kb_emb',
      name: 'EmbedTest',
      type: 'entity',
      embedding: emb,
    })
    const node = await adapter.getNode(id)
    expect(node).not.toBeNull()
    expect(node!.embedding).toBeDefined()
    expect(node!.embedding!.slice(0, 4)).toEqual(emb.map((v) => Math.round(v * 1e6) / 1e6))
  })

  it('updateNode 更新 embedding', async () => {
    if (!adapter) return
    const id = await adapter.addNode({ knowledgeBaseId: 'kb_emb', name: 'UpdTest', type: 'entity' })
    await adapter.updateNode(id, { embedding: [1, 0, 0, 0] })
    const node = await adapter.getNode(id)
    expect(node!.embedding).toBeDefined()
    expect(node!.embedding![0]).toBeCloseTo(1, 5)
  })

  it('反馈权重与真值状态持久化', async () => {
    if (!adapter) return
    const n1 = await adapter.addNode({ knowledgeBaseId: 'kb_fb', name: 'Node1', type: 'entity' })
    const n2 = await adapter.addNode({ knowledgeBaseId: 'kb_fb', name: 'Node2', type: 'entity' })
    await adapter.addEdge({ sourceId: n1, targetId: n2, relationshipName: 'rel', knowledgeBaseId: 'kb_fb' })

    // 初始为 null
    expect(await adapter.getNodeFeedbackWeights(n1)).toBeNull()
    expect(await adapter.getNodeTruthState(n1)).toBeNull()

    // 写入
    await adapter.setNodeFeedbackWeights(n1, { positive: 3, negative: 1 })
    await adapter.setNodeTruthState(n1, { truthValue: 0.85 })
    await adapter.setEdgeFeedbackWeights(n1, n2, 'rel', { positive: 2, negative: 0 })

    // 读回
    expect(await adapter.getNodeFeedbackWeights(n1)).toEqual({ positive: 3, negative: 1 })
    const ts = await adapter.getNodeTruthState(n1)
    expect(ts!.truthValue).toBeCloseTo(0.85, 5)
    expect(ts!.lastEvaluatedAt).toBeTruthy()
    expect(await adapter.getEdgeFeedbackWeights(n1, n2, 'rel')).toEqual({ positive: 2, negative: 0 })
  })

  it('supportsCypherQueries 应为 false', () => {
    if (!adapter) return
    expect(adapter.supportsCypherQueries).toBe(false)
  })

  it('TemporalConflictResolver 应将旧 functional 边标记 superseded', async () => {
    if (!adapter) return
    const n1 = await adapter.addNode({ knowledgeBaseId: 'kb_tc', name: '影刀RPA', type: 'product' })
    const n2 = await adapter.addNode({ knowledgeBaseId: 'kb_tc', name: '5.0', type: 'term' })
    const n3 = await adapter.addNode({ knowledgeBaseId: 'kb_tc', name: '6.0', type: 'term' })

    // functional 语义：同一 (source, relation) 只应有一个有效 target
    // 旧版本（effectiveDate 2024）
    await adapter.addEdge({
      sourceId: n1, targetId: n2, relationshipName: '版本为', knowledgeBaseId: 'kb_tc',
      properties: { effectiveDate: '2024-01-01' },
    })
    // 新版本（effectiveDate 2025）
    await adapter.addEdge({
      sourceId: n1, targetId: n3, relationshipName: '版本为', knowledgeBaseId: 'kb_tc',
      properties: { effectiveDate: '2025-06-01' },
    })

    const resolver = new TemporalConflictResolver(adapter)
    const result = await resolver.resolve('kb_tc')

    // 旧边（→5.0）应被标记 superseded，新边（→6.0）保留
    expect(result.supersededEdgeCount).toBe(1)
    expect(result.details).toHaveLength(1)
    expect(result.details[0].targetName).toBe('5.0')

    const edges = await adapter.getEdges(n1)
    const active = filterActiveEdges(edges)
    expect(active).toHaveLength(1)
    // 活跃边指向新版本 6.0
    const n3Node = await adapter.getNode(n3)
    expect(active.some((e) => e.targetId === n3Node!.id)).toBe(true)
  })

  it('TemporalConflictResolver 对同组多条边标记 superseded', async () => {
    if (!adapter) return
    const n1 = await adapter.addNode({ knowledgeBaseId: 'kb_tc2', name: '服务A', type: 'product' })
    const n2 = await adapter.addNode({ knowledgeBaseId: 'kb_tc2', name: '运行中', type: 'term' })
    const n3 = await adapter.addNode({ knowledgeBaseId: 'kb_tc2', name: '已停机', type: 'term' })

    // 同一 (source, relation) 指向两个不同 target：旧→运行中，新→已停机
    await adapter.addEdge({
      sourceId: n1, targetId: n2, relationshipName: '状态为', knowledgeBaseId: 'kb_tc2',
      properties: { effectiveDate: '2024-01-01' },
    })
    await adapter.addEdge({
      sourceId: n1, targetId: n3, relationshipName: '状态为', knowledgeBaseId: 'kb_tc2',
      properties: { effectiveDate: '2025-01-01' },
    })

    const resolver = new TemporalConflictResolver(adapter)
    const result = await resolver.resolve('kb_tc2')

    expect(result.supersededEdgeCount).toBe(1)
    expect(result.details).toHaveLength(1)
    expect(result.details[0].relation).toBe('状态为')

    // 验证失效标记已持久化
    const edges = await adapter.getEdges(n1)
    const supersededEdges = edges.filter((e) => e.properties?.superseded === true)
    expect(supersededEdges).toHaveLength(1)
    expect(filterActiveEdges(edges)).toHaveLength(1)
  })

  it('CodeGraphExtractor 应提取代码结构', async () => {
    if (!adapter) return
    const extractor = new CodeGraphExtractor(adapter)
    const result = await extractor.extractFromFiles(
      [
        {
          path: 'src/utils/helpers.ts',
          content: `import { Pool } from 'pg'\nimport path from 'path'\n\nexport class Helper {}\n\nexport function doWork() {}\nexport const VALUE = 1`,
        },
        {
          path: 'src/main.py',
          content: `import os\nimport sys\n\nclass Main:\n    def run(self):\n        pass`,
        },
      ],
      { knowledgeBaseId: 'kb_code', repositoryName: 'test-repo' }
    )

    expect(result.filesProcessed).toBe(2)
    expect(result.nodes).toBeGreaterThanOrEqual(5) // repo + 2 files + classes + functions + modules
    expect(result.edges).toBeGreaterThanOrEqual(5)

    // 验证提取的类和函数节点
    const helperClass = await adapter.findNodeByName('Helper', 'kb_code')
    expect(helperClass?.type).toBe('code_class')
    const doWork = await adapter.findNodeByName('doWork', 'kb_code')
    expect(doWork?.type).toBe('code_function')
    const pgModule = await adapter.findNodeByName('pg', 'kb_code')
    expect(pgModule?.type).toBe('code_module')
    expect(pgModule?.properties?.external).toBe(true)
  })

  it('RdfExporter 集成导出', async () => {
    if (!adapter) return
    const n1 = await adapter.addNode({ knowledgeBaseId: 'kb_rdf', name: 'Python', type: 'language' })
    const n2 = await adapter.addNode({ knowledgeBaseId: 'kb_rdf', name: 'FastAPI', type: 'technology' })
    await adapter.addEdge({ sourceId: n2, targetId: n1, relationshipName: '基于', knowledgeBaseId: 'kb_rdf' })

    const exporter = new RdfExporter(adapter)
    const turtle = await exporter.exportToTurtle({ knowledgeBaseId: 'kb_rdf' })
    expect(turtle).toContain('rdf:type :Language')
    expect(turtle).toContain(':基于')
  })
})