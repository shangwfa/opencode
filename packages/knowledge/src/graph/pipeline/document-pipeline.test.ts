import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { createHash } from 'node:crypto'
import { MDocument } from '@mastra/rag'
import type { GraphDB } from '../interface.js'
import type { GraphNode, GraphEdge, CombinedExtraction } from '../types.js'

// ── mock：LLM 抽取器（可控返回，避免真实网络） ──
const extractMock = ({ extract: mock() })
// 先快照真实模块，afterAll 恢复，避免 mock.module 注册表泄漏影响其它测试文件
const realEntityExtractor = { ...(await import('../extraction/entity-extractor.js' + '?real')) }
const realExtractionIndex = { ...(await import('../extraction/index.js' + '?real')) }
mock.module('../extraction/entity-extractor.js', () => ({
  EntityExtractor: class {
    extract = extractMock.extract
    constructor(_opts?: unknown) {}
  },
}))
// mock 默认嵌入工厂（避免真实网络）
mock.module('../extraction/index.js', () => ({
  ...realExtractionIndex,
  defaultEmbedFn: mock(async () => async (texts: string[]) => texts.map(() => [0.1, 0.2])),
}))
afterAll(() => {
  mock.module('../extraction/entity-extractor.js', () => realEntityExtractor)
  mock.module('../extraction/index.js', () => realExtractionIndex)
})

// 在依赖 mock 就绪后再导入被测模块
const { DocumentIngestPipeline } = await import('./document-pipeline.js')
const { InMemoryRdfQuadStore } = await import('../rdf/quad-store.js')
const { EntityExtractor } = await import('../extraction/entity-extractor.js')

// ── 最小内存图（pipeline 用到的方法） ──
function memoryGraph() {
  const nodes = new Map<string, GraphNode>()
  const edges = new Map<string, GraphEdge>()
  const docLinks: Array<{ documentId: string; nodeId: string }> = []
  let seq = 0

  const graph = {
    supportsCypherQueries: false,
    async addNodes(inputs: any[]) {
      return inputs.map((input) => {
        const id = input.id ?? `n${++seq}`
        nodes.set(id, { ...input, id, frequency: input.frequency ?? 1, createdAt: new Date(), updatedAt: new Date() } as GraphNode)
        return id
      })
    },
    async addEdges(inputs: any[]) {
      for (const e of inputs) {
        edges.set(`${e.sourceId}|${e.relationshipName}|${e.targetId}`, {
          ...e, weight: e.weight ?? 1, knowledgeBaseId: e.knowledgeBaseId ?? '', createdAt: new Date(), updatedAt: new Date(),
        } as GraphEdge)
      }
    },
    async deleteNodes(ids: string[]) {
      for (const id of ids) nodes.delete(id)
      for (const [k, e] of edges) {
        if (ids.includes(e.sourceId) || ids.includes(e.targetId)) edges.delete(k)
      }
    },
    async getNode(id: string) { return nodes.get(id) ?? null },
    async getGraphData() { return { nodes: [...nodes.values()], edges: [...edges.values()] } },
    async getNodeIdsByDocument(documentId: string) {
      return docLinks.filter((l) => l.documentId === documentId).map((l) => l.nodeId)
    },
    async getDocumentsByNodeIds(nodeIds: string[]) {
      const m = new Map<string, string[]>()
      for (const l of docLinks) {
        if (!nodeIds.includes(l.nodeId)) continue
        if (!m.has(l.nodeId)) m.set(l.nodeId, [])
        m.get(l.nodeId)!.push(l.documentId)
      }
      return m
    },
    async deleteDocumentLinks(documentId: string) {
      for (let i = docLinks.length - 1; i >= 0; i--) {
        if (docLinks[i].documentId === documentId) docLinks.splice(i, 1)
      }
    },
    async linkNodesToDocument(input: { documentId: string; nodeIds: string[] }) {
      for (const nodeId of input.nodeIds) docLinks.push({ documentId: input.documentId, nodeId })
    },
    _docLinks: docLinks,
    _nodes: nodes,
    _edges: edges,
  } as unknown as GraphDB & { _docLinks: typeof docLinks; _nodes: typeof nodes }
  return graph
}

// ── 支持 chunk 检查点的内存图 ──
function checkpointGraph() {
  const store = new Map<string, { chunkIndex: number; extraction: unknown; chunkHash?: string }[]>()
  const graph = {
    ...memoryGraph(),
    async loadDocumentChunkExtractions(documentId: string) {
      return store.get(documentId) || []
    },
    async saveDocumentChunkExtraction(documentId: string, chunkIndex: number, extraction: unknown, chunkHash?: string) {
      const list = store.get(documentId) || []
      list.push({ chunkIndex, extraction, chunkHash })
      store.set(documentId, list)
    },
    async deleteDocumentChunkExtractions(documentId: string) {
      store.delete(documentId)
    },
    _checkpoint: store,
  } as unknown as ReturnType<typeof memoryGraph> & { _checkpoint: typeof store }
  return graph
}

const TIPTAP = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: '测试文档' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'AlphaApp 支持 Linux 平台。BetaApp 基于 Gamma引擎。' }] },
  ],
}

function okExtraction(name: string): CombinedExtraction {
  return {
    entities: [{ name, type: 'product', description: '' }],
    triplets: [],
  }
}

describe('DocumentIngestPipeline（终端用户摄取入口）', () => {
  let graph: ReturnType<typeof memoryGraph>
  let pipeline: InstanceType<typeof DocumentIngestPipeline>

  beforeEach(() => {
    mock.clearAllMocks()
    graph = memoryGraph()
    pipeline = new DocumentIngestPipeline(graph, { embedFn: async (texts) => texts.map(() => [0.1, 0.2]) })
  })

  it('tiptap 内容：内置转换器生效，转换→分块→抽取→入图', async () => {
    extractMock.extract.mockResolvedValue(okExtraction('AlphaApp'))

    const r = await pipeline.ingest(TIPTAP, {
      knowledgeBaseId: 'kb',
      documentId: 'doc:1',
      type: 'tiptap',
    })

    expect(r.converter).toBe('builtin')
    expect(r.chunkCount).toBeGreaterThanOrEqual(1)
    expect(r.mode).toBe('llm')
    expect(r.nodeCount).toBeGreaterThan(0)
  })

  it('markdown 内容直接分块', async () => {
    extractMock.extract.mockResolvedValue(okExtraction('X'))
    const r = await pipeline.ingest('# 标题\n\n内容段落。', {
      knowledgeBaseId: 'kb', documentId: 'doc:2', type: 'markdown',
    })
    expect(r.chunkCount).toBeGreaterThanOrEqual(1)
  })

  it('空内容抛出"分块结果为空"', async () => {
    await expect(
      pipeline.ingest('   ', { knowledgeBaseId: 'kb', documentId: 'doc:3', type: 'text' })
    ).rejects.toThrow('分块结果为空')
  })

  it('tiptap 缺 converter 时使用内置 prosemirror 转换（不抛错）', async () => {
    extractMock.extract.mockResolvedValue(okExtraction('X'))
    const r = await pipeline.ingest(TIPTAP, { knowledgeBaseId: 'kb', documentId: 'doc:4', type: 'tiptap' })
    expect(r.chunkCount).toBeGreaterThanOrEqual(1)
  })

  it('支持注入 tiptap converter，并拒绝空转换结果', async () => {
    extractMock.extract.mockResolvedValue(okExtraction('Injected'))
    const converter = mock(() => '# injected')
    const result = await pipeline.ingest({ arbitrary: true }, { knowledgeBaseId: 'kb', documentId: 'doc:injected', type: 'tiptap', tiptapConverter: converter })
    expect(result.converter).toBe('injected')
    expect(converter).toHaveBeenCalledWith({ arbitrary: true })
    await expect(pipeline.ingest({}, { knowledgeBaseId: 'kb', documentId: 'doc:empty', type: 'tiptap', tiptapConverter: () => '  ' })).rejects.toThrow('tiptap 转换结果为空')
  })

  it('LLM 抽取为空时降级 fallbackExtractor（mode=fallback）', async () => {
    extractMock.extract.mockResolvedValue({ entities: [], triplets: [] })
    const r = await pipeline.ingest('AlphaApp 支持 Linux。', {
      knowledgeBaseId: 'kb', documentId: 'doc:5', type: 'text',
      fallbackExtractor: () => okExtraction('FallbackEntity'),
    })
    expect(r.mode).toBe('fallback')
    expect(r.nodeCount).toBeGreaterThan(0)
  })

  it('LLM 全失败且无 fallback：chunk 跳过、不崩溃', async () => {
    extractMock.extract.mockRejectedValue(new Error('代理挂了'))
    const r = await pipeline.ingest('AlphaApp 支持 Linux。', {
      knowledgeBaseId: 'kb', documentId: 'doc:6', type: 'text',
    })
    expect(r.mode).toBe('fallback')
    expect(r.nodeCount).toBe(0)
  })

  it('统计空 extraction chunk，并按批次回调进度', async () => {
    extractMock.extract.mockResolvedValue({ entities: [], triplets: [] })
    const progress = mock()
    const result = await pipeline.ingest('第一段内容。\n\n第二段内容。', {
      knowledgeBaseId: 'kb', documentId: 'doc:empty-chunks', type: 'text', concurrency: 1, onProgress: progress,
    })
    expect(result.emptyExtractionChunkCount).toBe(result.chunkCount)
    expect(progress).toHaveBeenLastCalledWith(result.chunkCount, result.chunkCount)
  })

  it('部分 chunk LLM 失败：并发容错，成功部分正常入图', async () => {
    // 生成足够长的文本触发多块；奇数块失败、偶数块成功
    extractMock.extract.mockImplementation(async (text: string) => {
      if (text.length % 2 === 1) throw new Error('偶发失败')
      return okExtraction(`实体${text.length}`)
    })
    const longText = Array.from({ length: 12 }, (_, i) => `第${i}段内容，包含一些文本用于分块测试。`).join('\n\n')
    const r = await pipeline.ingest(longText, {
      knowledgeBaseId: 'kb', documentId: 'doc:7', type: 'text',
      chunkConfig: { maxSize: 50, overlap: 5 },
    })
    expect(r.chunkCount).toBeGreaterThan(1)
    expect(r.nodeCount).toBeGreaterThan(0)
  })

  it('chunk 检查点：resume 跳过已缓存 chunk 的 LLM，成功整篇 merge 后清理检查点', async () => {
    const cg = checkpointGraph()
    const pipe = new DocumentIngestPipeline(cg, { embedFn: async (texts) => texts.map(() => [0.1, 0.2]) })
    const documentId = 'doc:ckpt'
    const content = 'CacheApp 是第一个主题段落，包含很多图谱相关的说明文字。\n\nNewApp 是第二个主题段落，同样包含大量图谱与抽取相关的说明文字。'
    // 预置缓存带 chunk 内容 hash（与管道一致的分块参数），模拟上次中断留下的 chunk0 抽取结果
    const ckptDoc = MDocument.fromText(content)
    const ckptChunks = (await ckptDoc.chunk({ strategy: 'recursive', maxSize: 40, overlap: 0, separators: ['\n\n', '\n', ' '] })) as Array<{ text?: string }>
    const chunk0Hash = createHash('sha256').update((ckptChunks[0]?.text || '').trim()).digest('hex')
    ;(cg as any)._checkpoint.set(documentId, [{ chunkIndex: 0, extraction: okExtraction('CacheApp'), chunkHash: chunk0Hash }])

    extractMock.extract.mockResolvedValue(okExtraction('NewApp'))
    const r = await pipe.ingest(content, {
      knowledgeBaseId: 'kb', documentId, type: 'text',
      chunkConfig: { maxSize: 40, overlap: 0 },
      chunkCheckpoint: true,
    })
    // chunk0 命中缓存不调 LLM；只有 chunk1 走抽取
    expect(r.chunkCount).toBeGreaterThan(1)
    expect(extractMock.extract).toHaveBeenCalledTimes(r.chunkCount - 1)
    const names = (await cg.getGraphData()).nodes.map((n) => n.name)
    expect(names).toContain('CacheApp')
    expect(names).toContain('NewApp')
    // 整篇 merge 成功后检查点被清理
    expect((cg as any)._checkpoint.get(documentId) || []).toHaveLength(0)
  })

  it('本体硬校验：违规实体被剔除并计入 violations', async () => {
    extractMock.extract.mockResolvedValue({
      entities: [
        { name: '合法产品', type: 'product', description: '' },
        { name: '违规物', type: 'alien_type', description: '' },
      ],
      triplets: [],
    })
    const r = await pipeline.ingest('合法产品 和 违规物 出现在文本中。', {
      knowledgeBaseId: 'kb', documentId: 'doc:8', type: 'text',
      ontology: {
        name: 'mini',
        nodes: [{ type: 'product' }],
        edges: [],
      },
    })
    expect(r.violations.length).toBeGreaterThanOrEqual(1)
    const names = (await graph.getGraphData()).nodes.map((n) => n.name)
    expect(names).toContain('合法产品')
    expect(names).not.toContain('违规物')
  })

  it('并发选项生效（concurrency 传透，不崩溃）', async () => {
    extractMock.extract.mockResolvedValue(okExtraction('X'))
    const longText = Array.from({ length: 20 }, (_, i) => `段落${i}内容。`).join('\n\n')
    const r = await pipeline.ingest(longText, {
      knowledgeBaseId: 'kb', documentId: 'doc:9', type: 'text', concurrency: 2,
      chunkConfig: { maxSize: 30, overlap: 0 },
    })
    expect(r.chunkCount).toBeGreaterThan(1)
  })

  it('写入 RDF facts、provenance 和 ontology 版本信息', async () => {
    extractMock.extract.mockResolvedValue(okExtraction('AlphaApp'))
    const rdfStore = new InMemoryRdfQuadStore()
    ;(graph as any).rdfStore = rdfStore
    const result = await pipeline.ingest('AlphaApp 产品。', {
      knowledgeBaseId: 'kb', documentId: 'doc:rdf', type: 'text', ontologyVersion: 'support@1',
      ontology: { name: 'support', nodes: [{ type: 'product', uri: 'urn:Product' }], edges: [] },
    })
    expect(result.nodeCount).toBeGreaterThan(0)
    expect((await rdfStore.match({ graph: 'urn:graph:knowledge:kb:support%401' })).length).toBe(2)
    expect((await rdfStore.match({ graph: 'urn:graph:provenance:doc:rdf:support@1' })).length).toBeGreaterThan(0)
  })

  it('RDF 写入失败时回滚本次文档图数据并抛错', async () => {
    extractMock.extract.mockResolvedValue(okExtraction('RollbackProduct'))
    ;(graph as any).rdfStore = { add: mock().mockRejectedValue(new Error('RDF unavailable')) }
    await expect(pipeline.ingest('RollbackProduct', {
      knowledgeBaseId: 'kb', documentId: 'doc:rdf-failure', type: 'text',
    })).rejects.toThrow('已回滚本次文档摄入')
    expect([...graph._nodes.values()].some((node) => node.name === 'RollbackProduct')).toBe(false)
    expect(graph._docLinks).toHaveLength(0)
  })
})

describe('DocumentIngestPipeline.removeDocument（文档删除 → 图清理）', () => {
  let graph: ReturnType<typeof memoryGraph>
  let pipeline: InstanceType<typeof DocumentIngestPipeline>

  beforeEach(() => {
    mock.clearAllMocks()
    graph = memoryGraph()
    pipeline = new DocumentIngestPipeline(graph, { embedFn: async (texts) => texts.map(() => [0.1, 0.2]) })
    extractMock.extract.mockResolvedValue({ entities: [], triplets: [] })
  })

  it('独占节点删除、共享节点保留、关联清理', async () => {
    // doc:1 抽取 SSO（独占），doc:2 与 doc:1 共享 影刀RPA
    const g = graph as any
    g._docLinks.push(
      { documentId: 'doc:1', nodeId: 'sso' },
      { documentId: 'doc:1', nodeId: 'yingdao' },
      { documentId: 'doc:2', nodeId: 'yingdao' },
    )
    g._nodes.set('sso', { id: 'sso', knowledgeBaseId: 'kb', name: 'SSO', type: 'feature', properties: {}, frequency: 1, createdAt: new Date(), updatedAt: new Date() })
    g._nodes.set('yingdao', { id: 'yingdao', knowledgeBaseId: 'kb', name: '影刀RPA', type: 'product', properties: {}, frequency: 2, createdAt: new Date(), updatedAt: new Date() })

    const r = await pipeline.removeDocument('doc:1')

    expect(r).toEqual({ removedNodes: 1, keptSharedNodes: 1 })
    expect(g._nodes.has('sso')).toBe(false)
    expect(g._nodes.has('yingdao')).toBe(true)
    expect(g._docLinks.filter((l: { documentId: string }) => l.documentId === 'doc:1')).toHaveLength(0)
  })

  it('不存在的文档：清理 0 项不抛错', async () => {
    const r = await pipeline.removeDocument('doc:missing')
    expect(r).toEqual({ removedNodes: 0, keptSharedNodes: 0 })
  })

  it('删除文档时同步清理 RDF facts 和 provenance', async () => {
    const rdfStore = new InMemoryRdfQuadStore()
    ;(graph as any).rdfStore = rdfStore
    await rdfStore.add([
      { id: 'knowledge', subject: { value: 'urn:s', kind: 'iri' }, predicate: { value: 'urn:p', kind: 'iri' }, object: { value: 'urn:o', kind: 'iri' }, graph: 'urn:graph:knowledge:kb', sourceChunkId: 'doc:1#0' },
      { id: 'provenance', subject: { value: 'urn:statement:x', kind: 'iri' }, predicate: { value: 'urn:prov', kind: 'iri' }, object: { value: 'urn:chunk:x', kind: 'iri' }, graph: 'urn:graph:provenance:run', sourceChunkId: 'doc:1#0' },
    ])
    await pipeline.removeDocument('doc:1')
    expect(await rdfStore.match()).toEqual([])
  })
})
