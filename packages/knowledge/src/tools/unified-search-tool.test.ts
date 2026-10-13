import { beforeEach, describe, expect, it, mock } from 'bun:test'

const graphSearchMock = { search: mock() }
mock.module('../graph/pipeline/search.js', () => ({ graphSearch: graphSearchMock.search }))

const persisterMock = { create: mock() }
mock.module('../graph/retrieval/trace-persister.js', () => ({
  createGraphTracePersister: persisterMock.create,
  persistRetrievalTrace: mock(async () => 'trace-persist-1'),
}))

const getGraphAdapterMock = { getGraphAdapter: mock() }
mock.module('../graph/pg-adapter/index.js', () => getGraphAdapterMock)

const hybridMock = { search: mock() }
mock.module('../rag/knowledge-base/index.js', () => ({
  hybridSearchService: { search: hybridMock.search },
}))

const traceLoggerMock = {
  getOrCreateTraceId: mock(() => 'trace-1'),
  appendRetrievalTraceId: mock(),
  logRagTrace: mock(),
}
mock.module('../utils/rag-trace-logger.js', () => traceLoggerMock)

// 绕过 createTool 的 execute 包装，直接测工具业务逻辑
mock.module('../utils/create-tool.js', () => ({
  createTool: mock((config: any) => config),
}))

// 在依赖 mock 就绪后再导入被测模块
const { createUnifiedSearchTool, unifiedSearchTool } = await import('./unified-search-tool.js')

function makeGraphResult() {
  const node = (id: string, name: string, type: string) => ({
    id, knowledgeBaseId: 'kb_1', name, type,
    properties: {}, frequency: 1, createdAt: new Date(), updatedAt: new Date(),
  })
  return {
    triplets: [
      { source: node('n1', '智能录制', 'feature'), relation: '包含', target: node('n2', '开始录制', 'action'), weight: 1, score: 0.9 },
      { source: node('n1', '智能录制', 'feature'), relation: '识别', target: node('n3', '鼠标键盘操作', 'action'), weight: 1, score: 0.8 },
    ],
    context: '[智能录制] --[包含]--> [开始录制]',
    entityCount: 3,
    edgeCount: 2,
    explanation: {
      seeds: [{ id: 'n1', name: '智能录制', type: 'feature' }],
      projectedNodeCount: 3,
      candidateCount: 2,
      filteredCount: 2,
      focus: [
        { source: '智能录制', relation: '包含', target: '开始录制', score: 0.9, rank: 0, sourceDocumentIds: ['doc_1'] },
        { source: '智能录制', relation: '识别', target: '鼠标键盘操作', score: 0.8, rank: 1, reason: '辅助关系' },
      ],
      filtersApplied: [],
      startedAt: new Date().toISOString(),
      durationMs: 10,
      traceId: 'node-trace-1',
    },
    sourceChunks: [],
  }
}

function makeDocResults() {
  return [
    { id: 'v1', text: '智能录制文档片段 A', score: 0.95, metadata: {}, documentId: 'doc_1', chunkIndex: 0 },
    { id: 'v2', text: '智能录制文档片段 B', score: 0.88, metadata: {}, documentId: 'doc_2', chunkIndex: 3 },
  ]
}

describe('unifiedSearchTool', () => {
  /** createTool 已被 mock 为透传；兼容裸数据与 { context } 两种调用形态 */
  const executeTool = async (tool: unknown, context: { query: string; topK?: number }) => {
    const execute = (tool as any).execute as (args: unknown) => Promise<any>
    return execute({ context })
  }

  /** 双路配置实例（unifiedSearchTool 默认实例未配 documentKbId，文档路会 skip） */
  const configuredTool = createUnifiedSearchTool({ graphKbId: 'kb_graph', documentKbId: 'kb_doc' })

  beforeEach(() => {
    mock.clearAllMocks()
    getGraphAdapterMock.getGraphAdapter.mockReturnValue({} as unknown)
    graphSearchMock.search.mockResolvedValue(makeGraphResult())
    hybridMock.search.mockResolvedValue(makeDocResults())
    persisterMock.create.mockReturnValue(mock())
  })

  it('两路成功：RRF 融合排序并标注来源', async () => {
    const output = await executeTool(configuredTool, { query: '智能录制包含什么', topK: 10 })

    expect(output.error).toBeUndefined()
    expect(output.degraded).toBe(false)
    expect(output.total).toBe(4)
    // 各分支 rank0 的 RRF 分（1/61）高于 rank1（1/62），graph 与 document 的 rank0 并列最高
    expect(output.results[0].score).toBeCloseTo(1 / 61, 6)
    expect(output.results[1].score).toBeCloseTo(1 / 61, 6)
    expect(output.results.slice(0, 2).map((r: any) => r.source).sort()).toEqual(['document', 'graph'])
    const graphItem = output.results.find((r: any) => r.source === 'graph')
    expect(graphItem).toMatchObject({ relation: '包含', documentId: 'doc_1' })
    const docItem = output.results.find((r: any) => r.source === 'document')
    expect(docItem).toMatchObject({ text: '智能录制文档片段 A', chunkIndex: 0 })
  })

  it('参数透传：graphKbId 进 graphSearch，documentKbId 进 hybridSearchService', async () => {
    const tool = createUnifiedSearchTool({ graphKbId: 'kb_graph', documentKbId: 'kb_doc' })
    await executeTool(tool, { query: 'q', topK: 5 })

    const graphOptions = graphSearchMock.search.mock.calls[0][1]
    expect(graphOptions.knowledgeBaseId).toBe('kb_graph')
    expect(graphOptions.topK).toBe(10) // topK*2 召回
    expect(typeof graphOptions.persistExplanation).toBe('function')
    expect(hybridMock.search).toHaveBeenCalledWith('kb_doc', 'q', expect.objectContaining({ topK: 10, fusionMethod: 'rrf' }))
  })

  it('图谱路失败：降级返回文档路，degraded=true 且无 error', async () => {
    graphSearchMock.search.mockRejectedValue(new Error('图连接失败'))

    const output = await executeTool(configuredTool, { query: 'q', topK: 10 })

    expect(output.error).toBeUndefined()
    expect(output.degraded).toBe(true)
    expect(output.total).toBe(2)
    expect(output.results.every((r: any) => r.source === 'document')).toBe(true)
    expect(output.retrievalDebug.graph.status).toBe('failed')
    expect(output.retrievalDebug.document.status).toBe('success')
  })

  it('文档路失败：降级返回图谱路', async () => {
    hybridMock.search.mockRejectedValue(new Error('向量库超时'))

    const output = await executeTool(configuredTool, { query: 'q', topK: 10 })

    expect(output.error).toBeUndefined()
    expect(output.degraded).toBe(true)
    expect(output.results.every((r: any) => r.source === 'graph')).toBe(true)
    expect(output.retrievalDebug.document.status).toBe('failed')
  })

  it('两路均失败：返回 error 字段而不抛异常', async () => {
    graphSearchMock.search.mockRejectedValue(new Error('图挂了'))
    hybridMock.search.mockRejectedValue(new Error('文档挂了'))

    const output = await executeTool(configuredTool, { query: 'q' })

    expect(output.results).toEqual([])
    expect(output.total).toBe(0)
    expect(output.degraded).toBe(true)
    expect(output.error).toContain('统一检索失败')
    expect(output.error).toContain('图挂了')
    expect(output.error).toContain('文档挂了')
  })

  it('未配置 documentKbId：文档路 skipped，不计入 degraded', async () => {
    const tool = createUnifiedSearchTool({ graphKbId: 'kb_graph' })
    const output = await executeTool(tool, { query: 'q', topK: 10 })

    expect(hybridMock.search).not.toHaveBeenCalled()
    expect(output.degraded).toBe(false)
    expect(output.retrievalDebug.document.status).toBe('skipped')
    expect(output.results.every((r: any) => r.source === 'graph')).toBe(true)
  })
})
