import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test'

const searchByQueryMock = ({ fn: mock() })

// 先快照真实模块，afterAll 恢复，避免 mock.module 注册表泄漏影响其它测试文件
const realGraphCompletionRetriever = { ...(await import('../retrieval/graph-completion-retriever.js' + '?real')) }
const realExtractionIndex = { ...(await import('../extraction/index.js' + '?real')) }

mock.module('../retrieval/graph-completion-retriever.js', () => ({
  GraphCompletionRetriever: class {
    searchByQuery = searchByQueryMock.fn
    constructor(_graph: unknown) {}
  },
}))
mock.module('../extraction/index.js', () => ({
  ...realExtractionIndex,
  defaultEmbedFn: mock(async () => async (texts: string[]) => texts.map(() => [0.1, 0.2])),
}))
afterAll(() => {
  mock.module('../retrieval/graph-completion-retriever.js', () => realGraphCompletionRetriever)
  mock.module('../extraction/index.js', () => realExtractionIndex)
})

// tools/graph-search-tool.test.ts 会 mock 本模块（跨文件 mock 注册表泄漏），
// 这里经 ?real 绕过 mock 注册表取回真实实现，并重新注册到常规路径
const realGraphSearch = await import('./search.js' + '?real')
mock.module('./search.js', () => ({ ...realGraphSearch }))
// 在依赖 mock 就绪后再导入被测模块
const { graphSearch } = await import('./search.js')

function fakeResult() {
  return {
    triplets: [],
    context: '',
    entityCount: 1,
    edgeCount: 1,
    explanation: {
      question: '', seeds: [], projectedNodeCount: 0, candidateCount: 0,
      filteredCount: 0, focus: [], filtersApplied: [],
      startedAt: new Date().toISOString(), durationMs: 1,
    },
  } as never
}

describe('graphSearch（一站式检索入口）', () => {
  beforeEach(() => {
    mock.clearAllMocks()
    searchByQueryMock.fn.mockResolvedValue(fakeResult())
  })

  it('查询文本先嵌入（defaultEmbedFn），再交给检索器', async () => {
    await graphSearch({} as never, { query: '测试查询' })

    expect(searchByQueryMock.fn).toHaveBeenCalledTimes(1)
    const [query, queryEmbedding, options] = searchByQueryMock.fn.mock.calls[0]
    expect(query).toBe('测试查询')
    expect(queryEmbedding).toEqual([0.1, 0.2])
    expect(options.topK).toBe(5)
    expect(options.neighborDepth).toBe(2)
  })

  it('注入 embedFn 时优先使用注入', async () => {
    const embedFn = mock(async (texts: string[]) => texts.map(() => [0.9, 0.9]))
    await graphSearch({} as never, { query: 'q', embedFn })

    const [, queryEmbedding] = searchByQueryMock.fn.mock.calls[0]
    expect(queryEmbedding).toEqual([0.9, 0.9])
  })

  it('rerank 未注入 embedTexts 时继承查询嵌入函数', async () => {
    const embedFn = mock(async (texts: string[]) => texts.map(() => [0.1, 0.2]))
    await graphSearch({} as never, { query: 'q', embedFn, rerank: { mode: 'embedding' } })

    const options = searchByQueryMock.fn.mock.calls[0][2]
    expect(options.rerank.embedTexts).toBe(embedFn)
  })

  it('minScore / persistExplanation / knowledgeBaseId 透传', async () => {
    const persist = mock()
    await graphSearch({} as never, {
      query: 'q',
      knowledgeBaseId: 'kb_1',
      minScore: 0.5,
      persistExplanation: persist,
    })

    const options = searchByQueryMock.fn.mock.calls[0][2]
    expect(options.minScore).toBe(0.5)
    expect(options.persistExplanation).toBe(persist)
    expect(options.knowledgeBaseId).toBe('kb_1')
  })

  it('strictRelevance 透传', async () => {
    await graphSearch({} as never, { query: '不存在的功能', strictRelevance: true })
    expect(searchByQueryMock.fn.mock.calls[0][2].strictRelevance).toBe(true)
  })

  it('ontology、reason 和 decompose 选项透传', async () => {
    const ontology = { name: 'test', nodes: [], edges: [] }
    const reason = { enabled: true, maxEdges: 2 }
    const decompose = { enabled: false, maxSubQueries: 2 }
    await graphSearch({} as never, { query: 'q', ontology, reason, decompose })
    const options = searchByQueryMock.fn.mock.calls[0][2]
    expect(options.ontology).toBe(ontology)
    expect(options.reason).toBe(reason)
    expect(options.decompose).toBe(decompose)
  })
})
