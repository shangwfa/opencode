import { beforeEach, describe, expect, it, mock } from 'bun:test'
import type { GraphDB } from '../interface.js'
import type { GraphNode, GraphEdge } from '../types.js'

const { generateObjectMock } = ({ generateObjectMock: mock() })

mock.module('ai', () => ({
  generateObject: generateObjectMock,
  embed: mock(),
  embedMany: mock(),
}))
mock.module('../../utils/model-resolver.js', () => ({
  resolveModel: mock(() => ({ modelId: 'mock-model' })),
}))

// 在依赖 mock 就绪后再导入被测模块
// 注意：pipeline/search.test.ts 会 mock 本模块（跨文件注册表污染），此处经 ?real 绕过 mock 注册表
// 取回真实实现，并重新注册到常规路径，保证本文件及后续文件拿到真实被测类
const realGraphCompletionRetriever = await import('./graph-completion-retriever.js' + '?real')
mock.module('./graph-completion-retriever.js', () => ({ ...realGraphCompletionRetriever }))
const { GraphCompletionRetriever } = await import('./graph-completion-retriever.js')

function makeNode(id: string, name: string, type = 'entity', embedding?: number[]): GraphNode {
  return {
    id, knowledgeBaseId: 'kb_1', name, type,
    properties: {}, frequency: 1,
    embedding,
    createdAt: new Date(), updatedAt: new Date(),
  }
}

function makeEdge(source: GraphNode, target: GraphNode, rel: string, properties: Record<string, unknown> = {}): GraphEdge {
  return {
    sourceId: source.id, targetId: target.id, relationshipName: rel,
    properties, weight: 1, knowledgeBaseId: 'kb_1',
    createdAt: new Date(), updatedAt: new Date(),
  }
}

/** 构造一个小型图：Python--用于-->pandas（与查询相关）、无关A--相关-->无关B（与查询无关） */
function buildMockGraph() {
  const python = makeNode('n_python', 'Python', 'language', [1, 0, 0])
  const pandas = makeNode('n_pandas', 'pandas', 'technology', [0.9, 0.1, 0])
  const unrelatedA = makeNode('n_ua', '无关A', 'concept', [-1, 0, 0])
  const unrelatedB = makeNode('n_ub', '无关B', 'concept', [-0.9, 0.1, 0])

  const relevantEdge = makeEdge(python, pandas, '用于', { sourceDocumentIds: ['doc_42'] })
  const noiseEdge = makeEdge(unrelatedA, unrelatedB, '相关')

  const graph = {
    findSimilarNodesByEmbedding: mock(async () => [python, unrelatedA]),
    getNeighborhood: mock(async () => ({
      nodes: [python, pandas, unrelatedA, unrelatedB],
      edges: [relevantEdge, noiseEdge],
    })),
    getNodes: mock(async (ids: string[]) =>
      [python, pandas, unrelatedA, unrelatedB].filter((n) => ids.includes(n.id))
    ),
    getGraphData: mock(async () => ({ nodes: [], edges: [] })),
    getEdges: mock(async (nodeId: string) =>
      nodeId === python.id ? [relevantEdge] : nodeId === unrelatedA.id ? [noiseEdge] : []
    ),
  } as unknown as GraphDB

  return { graph, python, pandas, unrelatedA, unrelatedB, relevantEdge, noiseEdge }
}

describe('GraphCompletionRetriever 检索解释结构（对标 TrustGraph 解释 DAG）', () => {
  let graph: GraphDB

  beforeEach(() => {
    graph = buildMockGraph().graph
    generateObjectMock.mockReset()
  })

  it('search 返回完整 explanation：seeds/focus/计数/耗时', async () => {
    const retriever = new GraphCompletionRetriever(graph)
    const result = await retriever.search([1, 0, 0], { topK: 5, neighborDepth: 2 })

    const exp = result.explanation
    expect(exp).toBeDefined()
    expect(exp.seeds.length).toBeGreaterThan(0)
    expect(exp.seeds[0]).toMatchObject({ id: expect.any(String), name: expect.any(String), type: expect.any(String) })
    expect(exp.projectedNodeCount).toBe(4)
    expect(exp.candidateCount).toBeGreaterThanOrEqual(exp.filteredCount)
    expect(exp.filteredCount).toBeGreaterThan(0)
    expect(exp.focus).toHaveLength(result.triplets.length)
    // focus 与返回的 triplets 逐条对齐且 rank 递增
    exp.focus.forEach((f, i) => {
      expect(f.rank).toBe(i + 1)
      expect(f.source).toBe(result.triplets[i].source.name)
      expect(f.relation).toBe(result.triplets[i].relation)
      expect(f.target).toBe(result.triplets[i].target.name)
    })
    expect(exp.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(exp.durationMs).toBeGreaterThanOrEqual(0)
    expect(exp.filtersApplied.length).toBeGreaterThan(0)
  })

  it('无种子时返回空 explanation（grounding 为空）', async () => {
    const emptyGraph = {
      findSimilarNodesByEmbedding: mock(async () => []),
      getGraphData: mock(async () => ({ nodes: [], edges: [] })),
    } as unknown as GraphDB
    const retriever = new GraphCompletionRetriever(emptyGraph)
    const result = await retriever.search([1, 0, 0], { topK: 5, neighborDepth: 2 })

    expect(result.triplets).toEqual([])
    expect(result.explanation.seeds).toEqual([])
    expect(result.explanation.candidateCount).toBe(0)
    expect(result.explanation.focus).toEqual([])
  })

  it('filtersApplied 反映传入的过滤条件', async () => {
    const retriever = new GraphCompletionRetriever(graph)
    const result = await retriever.search([1, 0, 0], {
      topK: 5,
      neighborDepth: 2,
      relationTypes: ['用于'],
      sourceNames: ['Python'],
    })
    const joined = result.explanation.filtersApplied.join(';')
    expect(joined).toContain('用于')
    expect(joined).toContain('Python')
  })
})

describe('GraphCompletionRetriever rerank 接入（对标 TrustGraph cross-encoder rerank）', () => {
  let graph: GraphDB

  beforeEach(() => {
    graph = buildMockGraph().graph
    generateObjectMock.mockReset()
  })

  it('embedding 精排把语义相关边排到首位并记录 rerank 信息', async () => {
    const retriever = new GraphCompletionRetriever(graph)
    const result = await retriever.search([1, 0, 0], {
      topK: 5,
      neighborDepth: 2,
      rerank: {
        mode: 'embedding',
        weight: 0.9,
        embedTexts: async (texts) =>
          texts.map((t) => (t.includes('Python') ? [1, 0, 0] : [-1, 0, 0])),
      },
    })

    expect(result.explanation.rerank).toMatchObject({ mode: 'embedding', applied: true })
    expect(result.triplets[0].source.name).toBe('Python')
    expect(result.triplets[0].relation).toBe('用于')
  })

  it('rerank 失败时降级：保留原排序且不中断检索', async () => {
    const retriever = new GraphCompletionRetriever(graph)
    const result = await retriever.search([1, 0, 0], {
      topK: 5,
      neighborDepth: 2,
      rerank: {
        mode: 'embedding',
        embedTexts: async () => {
          throw new Error('嵌入服务不可用')
        },
      },
    })

    expect(result.explanation.rerank).toMatchObject({
      mode: 'embedding',
      applied: false,
    })
    expect(result.explanation.rerank?.error).toContain('嵌入服务不可用')
    expect(result.triplets.length).toBeGreaterThan(0)
  })

  it('searchByQuery 自动透传 query 文本给 llm 精排', async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: { scores: [{ index: 0, relevance: 9 }, { index: 1, relevance: 1 }] },
    })

    const retriever = new GraphCompletionRetriever(graph)
    const result = await retriever.searchByQuery('Python 能做什么数据分析', [1, 0, 0], {
      topK: 5,
      neighborDepth: 2,
      rerank: { mode: 'llm', weight: 0.9 },
    })

    expect(result.explanation.rerank).toMatchObject({ mode: 'llm', applied: true })
    // llm 收到的 prompt 应包含原始查询文本
    const prompt = generateObjectMock.mock.calls[0][0].prompt as string
    expect(prompt).toContain('Python 能做什么数据分析')
  })

  it('searchTriplets 同样支持 rerank 精排', async () => {
    const retriever = new GraphCompletionRetriever(graph)
    const triplets = await retriever.searchTriplets({
      queryEmbedding: [1, 0, 0],
      topK: 5,
      rerank: {
        mode: 'embedding',
        weight: 0.9,
        embedTexts: async (texts) =>
          texts.map((t) => (t.includes('Python') ? [1, 0, 0] : [-1, 0, 0])),
      },
    })

    expect(triplets.length).toBeGreaterThan(0)
    expect(triplets[0].source.name).toBe('Python')
  })
})

describe('GraphCompletionRetriever TrustGraph 检索管道新能力', () => {
  let graph: GraphDB

  beforeEach(() => {
    graph = buildMockGraph().graph
    generateObjectMock.mockReset()
  })

  it('边推理：focus 每条边携带 LLM 解释', async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: { reasons: [{ index: 0, reason: 'Python 用于数据分析直接回答了问题' }] },
    })

    const retriever = new GraphCompletionRetriever(graph)
    const result = await retriever.search([1, 0, 0], {
      topK: 5,
      neighborDepth: 2,
      queryText: 'Python 能做什么',
      reason: { enabled: true },
    })

    expect(result.explanation.focus[0].reason).toContain('Python')
  })

  it('缺 queryText 时边推理跳过（不调用 LLM）', async () => {
    const retriever = new GraphCompletionRetriever(graph)
    const result = await retriever.search([1, 0, 0], {
      topK: 5,
      neighborDepth: 2,
      reason: { enabled: true },
    })

    expect(result.explanation.focus.some((f) => f.reason)).toBe(false)
    expect(generateObjectMock).not.toHaveBeenCalled()
  })

  it('检索解释持久化钩子被调用并携带解释与查询', async () => {
    const persist = mock(async (
      _explanation: import('../types.js').RetrievalExplanation,
      _ctx: import('./trace-persister.js').TracePersistContext
    ) => {})
    const retriever = new GraphCompletionRetriever(graph)
    await retriever.searchByQuery('Python 的用途', [1, 0, 0], {
      topK: 5,
      neighborDepth: 2,
      persistExplanation: persist,
    })

    expect(persist).toHaveBeenCalledTimes(1)
    const [explanation, ctx] = persist.mock.calls[0]
    expect(explanation.focus.length).toBeGreaterThan(0)
    expect(ctx.queryText).toBe('Python 的用途')
  })

  it('持久化失败不影响检索结果', async () => {
    const retriever = new GraphCompletionRetriever(graph)
    const result = await retriever.search([1, 0, 0], {
      topK: 5,
      neighborDepth: 2,
      persistExplanation: async () => {
        throw new Error('存储不可写')
      },
    })

    expect(result.triplets.length).toBeGreaterThan(0)
  })

  it('文档回链：focus 带出来源文档 ID', async () => {
    const retriever = new GraphCompletionRetriever(graph)
    const result = await retriever.search([1, 0, 0], { topK: 5, neighborDepth: 2 })

    const pythonFocus = result.explanation.focus.find((f) => f.source === 'Python')
    expect(pythonFocus?.sourceDocumentIds).toEqual(['doc_42'])
  })

  it('getEdges 抛错时文档回链静默缺失', async () => {
    const brokenGraph = {
      ...buildMockGraph().graph,
      getEdges: mock(async () => {
        throw new Error('查询失败')
      }),
    } as unknown as GraphDB

    const retriever = new GraphCompletionRetriever(brokenGraph)
    const result = await retriever.search([1, 0, 0], { topK: 5, neighborDepth: 2 })

    expect(result.explanation.focus.some((f) => f.sourceDocumentIds)).toBe(false)
    expect(result.triplets.length).toBeGreaterThan(0)
  })

  it('概念分解：LLM 拆子查询→独立嵌入→去重合并→记录 subQueries', async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: { subQueries: ['Python 用于什么', 'pandas 是什么'] },
    })

    const retriever = new GraphCompletionRetriever(graph)
    const result = await retriever.searchByQuery('Python 和 pandas 的关系', [1, 0, 0], {
      topK: 6,
      neighborDepth: 2,
      decompose: {
        enabled: true,
        embedTexts: async (texts) => texts.map(() => [1, 0, 0]),
      },
    })

    expect(result.explanation.subQueries).toEqual(['Python 用于什么', 'pandas 是什么'])
    expect(result.explanation.seeds.length).toBeGreaterThan(0)
    expect(result.triplets.length).toBeGreaterThan(0)
    // 分解导致候选去重后的 filteredCount 不小于单查询场景的返回数
    expect(result.explanation.filteredCount).toBeGreaterThan(0)
  })

  it('分解 LLM 失败时退化为单查询检索', async () => {
    generateObjectMock.mockRejectedValueOnce(new Error('分解超时'))

    const retriever = new GraphCompletionRetriever(graph)
    const result = await retriever.searchByQuery('简单问题', [1, 0, 0], {
      topK: 5,
      neighborDepth: 2,
      decompose: { enabled: true },
    })

    expect(result.triplets.length).toBeGreaterThan(0)
    expect(result.explanation.subQueries).toBeUndefined()
  })
})

describe('GraphCompletionRetriever 合成上下文（对标 answer synthesis 输入）', () => {
  beforeEach(() => {
    generateObjectMock.mockReset()
  })

  it('context 行包含边推理与来源文档标注', async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: { reasons: [{ index: 0, reason: '直接回答问题的关系' }] },
    })
    const retriever = new GraphCompletionRetriever(buildMockGraph().graph)
    const result = await retriever.searchByQuery('Python 能做什么', [1, 0, 0], {
      topK: 5,
      neighborDepth: 2,
      reason: { enabled: true },
    })

    const pythonLine = result.context.split('\n').find((l) => l.includes('Python'))
    expect(pythonLine).toContain('关联：直接回答问题的关系')
    expect(pythonLine).toContain('来源文档: doc_42')
  })

  it('无 reason 时 context 不含关联标注（来源文档标注保留）', async () => {
    const retriever = new GraphCompletionRetriever(buildMockGraph().graph)
    const result = await retriever.search([1, 0, 0], { topK: 5, neighborDepth: 2 })

    expect(result.context).toMatch(/^\[.+\] --\[.+\]--> \[.+\]/m)
    expect(result.context).not.toContain('关联：')
    expect(result.context).toContain('来源文档: doc_42')
  })
})

describe('GraphCompletionRetriever 语义对齐修复验证', () => {
  beforeEach(() => {
    generateObjectMock.mockReset()
  })

  it('explanation.question 记录原始查询（解释 DAG 起点）', async () => {
    const retriever = new GraphCompletionRetriever(buildMockGraph().graph)
    const result = await retriever.searchByQuery('Python 和 pandas 有什么关系', [1, 0, 0], {
      topK: 5,
      neighborDepth: 2,
    })

    expect(result.explanation.question).toBe('Python 和 pandas 有什么关系')
  })

  it('search 无 queryText 时 question 缺省不报错', async () => {
    const retriever = new GraphCompletionRetriever(buildMockGraph().graph)
    const result = await retriever.search([1, 0, 0], { topK: 5, neighborDepth: 2 })

    expect(result.explanation.question).toBeUndefined()
  })

  it('分解模式下 rerank 收到子查询参考向量（子话题候选不被压低）', async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: { subQueries: ['Python 用于什么', 'pandas 是什么'] },
    })

    const retriever = new GraphCompletionRetriever(buildMockGraph().graph)
    const captured: number[][][] = []
    const result = await retriever.searchByQuery('Python 和 pandas 的关系', [1, 0, 0], {
      topK: 6,
      neighborDepth: 2,
      rerank: {
        mode: 'embedding',
        weight: 0.9,
        embedTexts: async (texts) => texts.map(() => [1, 0, 0]),
      },
      decompose: {
        enabled: true,
        embedTexts: async (texts) => texts.map(() => [0, 1, 0]),
      },
    })

    void captured
    // 分解 + rerank 组合正常产出且解释记录子查询
    expect(result.explanation.subQueries).toEqual(['Python 用于什么', 'pandas 是什么'])
    expect(result.explanation.rerank?.applied).toBe(true)
    expect(result.triplets.length).toBeGreaterThan(0)
  })
})

describe('Synthesis 回填（对标 TrustGraph Synthesis 溯源）', () => {
  beforeEach(() => {
    generateObjectMock.mockReset()
  })

  it('persistExplanation 返回的 traceId 写入 explanation', async () => {
    const retriever = new GraphCompletionRetriever(buildMockGraph().graph)
    const result = await retriever.search([1, 0, 0], {
      topK: 5,
      neighborDepth: 2,
      persistExplanation: async () => 'trace_abc123',
    })

    expect(result.explanation.traceId).toBe('trace_abc123')
  })

  it('persister 无返回值时 traceId 保持缺失', async () => {
    const retriever = new GraphCompletionRetriever(buildMockGraph().graph)
    const result = await retriever.search([1, 0, 0], {
      topK: 5,
      neighborDepth: 2,
      persistExplanation: async () => {},
    })

    expect(result.explanation.traceId).toBeUndefined()
  })
})
