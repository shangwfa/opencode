import { afterAll, afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test'
import type { GraphDB } from '../interface.js'
import type { GraphNode } from '../types.js'
import type { CompletionResult } from '../retrieval/graph-completion-retriever.js'

const graphSearchMock = ({ search: mock() })
const persisterMock = ({ create: mock() })
const getGraphAdapterMock = ({ getGraphAdapter: mock() })
const traceLoggerMock = ({
  getOrCreateTraceId: mock(() => 'trace-1'),
  appendRetrievalTraceId: mock(),
  logRagTrace: mock(),
})

// 先快照真实模块，afterAll 恢复，避免 mock.module 注册表泄漏影响其它测试文件
const realSearch = { ...(await import('../pipeline/search.js' + '?real')) }
const realTracePersister = { ...(await import('../retrieval/trace-persister.js' + '?real')) }
const realPgAdapterIndex = { ...(await import('../pg-adapter/index.js' + '?real')) }
const realRagTraceLogger = { ...(await import('../../utils/rag-trace-logger.js' + '?real')) }
const realCreateTool = { ...(await import('../../utils/create-tool.js' + '?real')) }

mock.module('../pipeline/search.js', () => ({ graphSearch: graphSearchMock.search }))

mock.module('../retrieval/trace-persister.js', () => ({
  createGraphTracePersister: persisterMock.create,
}))

mock.module('../pg-adapter/index.js', () => getGraphAdapterMock)

mock.module('../../utils/rag-trace-logger.js', () => traceLoggerMock)

// 绕过 mastra 的 execute 包装，直接测工具业务逻辑
mock.module('../../utils/create-tool.js', () => ({
  createTool: mock((config) => config),
}))

afterAll(() => {
  mock.module('../pipeline/search.js', () => realSearch)
  mock.module('../retrieval/trace-persister.js', () => realTracePersister)
  mock.module('../pg-adapter/index.js', () => realPgAdapterIndex)
  mock.module('../../utils/rag-trace-logger.js', () => realRagTraceLogger)
  mock.module('../../utils/create-tool.js', () => realCreateTool)
})

// 在依赖 mock 就绪后再导入被测模块
const { createGraphSearchTool, graphSearchTool } = await import('./graph-search-tool.js')

function makeNode(id: string, name: string, type: string): GraphNode {
  return {
    id, knowledgeBaseId: 'kb_1', name, type,
    properties: {}, frequency: 1,
    createdAt: new Date(), updatedAt: new Date(),
  }
}

function makeCompletionResult(overrides: Partial<CompletionResult> = {}): CompletionResult {
  const python = makeNode('n1', 'Python', 'language')
  const pandas = makeNode('n2', 'pandas', 'technology')
  return {
    triplets: [
      { source: python, relation: '用于', target: pandas, weight: 1, score: 0.9 },
    ],
    context: '[Python] --[用于]--> [pandas]',
    entityCount: 2,
    edgeCount: 1,
    explanation: {
      seeds: [{ id: 'n1', name: 'Python', type: 'language' }],
      projectedNodeCount: 2,
      candidateCount: 1,
      filteredCount: 1,
      focus: [
        {
          source: 'Python', relation: '用于', target: 'pandas', score: 0.9, rank: 0,
          reason: '直接回答问题的关系',
          sourceDocumentIds: ['doc_42'],
        },
      ],
      filtersApplied: ['exclude:is_a（默认）'],
      startedAt: new Date().toISOString(),
      durationMs: 5,
      traceId: 'node-trace-7',
    },
    sourceChunks: [
      { chunkId: 'doc_42#0', documentId: 'doc_42', chunkIndex: 0, content: 'pandas 基于 Python' },
    ],
    ...overrides,
  }
}

describe('graphSearchTool', () => {
  /** createTool 已被 mock 为透传，execute 只需 context 参数；统一 cast 规避 mastra 类型签名 */
  const executeTool = async (
    tool: unknown,
    context: { query: string; topK?: number; neighborDepth?: number }
  ) => {
    const execute = (tool as any).execute as (args: { context: unknown }) => Promise<any>
    return execute({ context })
  }

  beforeEach(() => {
    mock.clearAllMocks()
    getGraphAdapterMock.getGraphAdapter.mockReturnValue({} as GraphDB)
    graphSearchMock.search.mockResolvedValue(makeCompletionResult())
    persisterMock.create.mockReturnValue(mock())
  })

  it('返回三元组、上下文、实体计数与溯源信息', async () => {
    const output = await executeTool(graphSearchTool, { query: 'Python 和 pandas 的关系', topK: 10, neighborDepth: 2 })

    expect(output).toMatchObject({
      context: '[Python] --[用于]--> [pandas]',
      entityCount: 2,
    })
    expect(output.error).toBeUndefined()
    expect(output.triplets).toEqual([
      {
        source: 'Python',
        sourceType: 'language',
        relation: '用于',
        target: 'pandas',
        targetType: 'technology',
        score: 0.9,
        reason: '直接回答问题的关系',
        sourceDocumentIds: ['doc_42'],
      },
    ])
    expect(output.sourceChunks).toEqual([
      { chunkId: 'doc_42#0', documentId: 'doc_42', chunkIndex: 0, content: 'pandas 基于 Python' },
    ])
    expect(output.retrievalDebug).toMatchObject({ traceId: 'node-trace-7' })
  })

  it('走一站式 graphSearch：透传查询参数并接入 trace 持久化', async () => {
    await executeTool(graphSearchTool, { query: 'q', topK: 5, neighborDepth: 3 })

    expect(getGraphAdapterMock.getGraphAdapter).toHaveBeenCalled()
    expect(graphSearchMock.search).toHaveBeenCalledTimes(1)
    const [graph, options] = graphSearchMock.search.mock.calls[0]
    expect(options).toMatchObject({ query: 'q', topK: 5, neighborDepth: 3 })
    expect(typeof options.persistExplanation).toBe('function')
    // persistExplanation 由 createGraphTracePersister(graph) 生成
    expect(persisterMock.create).toHaveBeenCalledWith(graph)
    expect(traceLoggerMock.logRagTrace).toHaveBeenCalledWith(
      expect.objectContaining({ step: 'retrieval_start', metadata: { tool: 'knowledge-graph-search' } })
    )
  })

  it('工厂参数 knowledgeBaseId 限定图空间', async () => {
    const tool = createGraphSearchTool({ knowledgeBaseId: 'kb_openapi' })
    await executeTool(tool, { query: 'q' })

    const options = graphSearchMock.search.mock.calls.at(-1)![1]
    expect(options.knowledgeBaseId).toBe('kb_openapi')
  })

  it('任意环节失败时返回 error 字段而不抛异常', async () => {
    graphSearchMock.search.mockRejectedValue(new Error('嵌入配额耗尽'))

    const output = await executeTool(graphSearchTool, { query: 'q', topK: 5 })

    expect(output.triplets).toEqual([])
    expect(output.context).toBe('')
    expect(output.entityCount).toBe(0)
    expect(output.error).toContain('知识图谱搜索失败')
    expect(output.error).toContain('嵌入配额耗尽')
    expect(traceLoggerMock.logRagTrace).toHaveBeenCalledWith(
      expect.objectContaining({ step: 'retrieval_failed' })
    )
  })

  it('超时后返回 error 字段而非挂起', async () => {
    jest.useFakeTimers()
    try {
      graphSearchMock.search.mockReturnValue(new Promise(() => {}))
      const tool = createGraphSearchTool({ timeoutMs: 100 })
      const pending = executeTool(tool, { query: 'q' })
      // bun test 无 advanceTimersByTimeAsync，用同步推进 + 微任务让出替代
      jest.advanceTimersByTime(150)
      await Promise.resolve()
      const output = await pending
      expect(output.error).toContain('超时')
    } finally {
      jest.useRealTimers()
    }
  })
})
