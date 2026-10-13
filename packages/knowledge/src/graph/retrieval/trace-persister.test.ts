import { describe, expect, it, mock } from 'bun:test'
import type { GraphDB } from '../interface.js'
import type { GraphNode } from '../types.js'
import type { RetrievalExplanation } from '../types.js'

// tools/graph-search-tool.test.ts 会 mock 本模块（跨文件 mock 注册表泄漏），
// 这里经 ?real 绕过 mock 注册表取回真实实现，并重新注册到常规路径
const realTracePersister = { ...(await import('./trace-persister.js' + '?real')) }
mock.module('./trace-persister.js', () => ({ ...realTracePersister }))
// 直接从真实实现快照取值（bun 的 mock 包装对象可能按首次注册的导出名截断，这里绕开）
const {
  createGraphTracePersister,
  persistRetrievalTrace,
  listRetrievalTraces,
  updateTraceAnswer,
  traceEdgeProvenance,
  RETRIEVAL_TRACE_NODE_TYPE,
} = realTracePersister as any

function makeExplanation(): RetrievalExplanation {
  return {
    seeds: [{ id: 'n1', name: 'Python', type: 'language' }],
    projectedNodeCount: 4,
    candidateCount: 6,
    filteredCount: 3,
    focus: [{ source: 'Python', relation: '用于', target: 'pandas', score: 0.9, rank: 0 }],
    filtersApplied: ['exclude:is_a（默认）'],
    startedAt: new Date().toISOString(),
    durationMs: 12,
  }
}

describe('createGraphTracePersister（对标 TrustGraph 检索 provenance 审计）', () => {
  it('把解释写为 retrieval_trace 类型节点', async () => {
    const addNode = mock(async (_input: unknown) => 'trace_id')
    const graph = { addNode } as unknown as GraphDB
    const persister = createGraphTracePersister(graph)

    const explanation = makeExplanation()
    await persister(explanation, { queryText: 'Python 的用途', knowledgeBaseId: 'kb_1' })

    expect(addNode).toHaveBeenCalledTimes(1)
    const input = addNode.mock.calls[0][0] as import('../types.js').CreateNodeInput
    expect(input.type).toBe(RETRIEVAL_TRACE_NODE_TYPE)
    expect(input.properties!.kind).toBe('retrieval_trace')
    expect(input.properties!.queryText).toBe('Python 的用途')
    expect(input.properties!.explanation).toBe(explanation)
    expect(input.knowledgeBaseId).toBe('__retrieval__:kb_1')
    expect(input.name).toContain('Python 的用途')
    expect(input.id).toBeDefined()
  })

  it('缺省 queryText 时进入 retrieval 逻辑命名空间', async () => {
    const addNode = mock(async (_input: unknown) => 'trace_id')
    const graph = { addNode } as unknown as GraphDB

    await createGraphTracePersister(graph)(makeExplanation(), {})

    const input = addNode.mock.calls[0][0] as import('../types.js').CreateNodeInput
    expect(input.knowledgeBaseId).toBe('__retrieval__:global')
    expect(input.properties!.queryText).toBeNull()
    expect(input.properties!.graphName).toBe('urn:graph:retrieval')
  })
})

describe('listRetrievalTraces', () => {
  function makeNode(id: string, name: string, createdAt: Date, explanation: unknown): GraphNode {
    return {
      id, knowledgeBaseId: 'kb_1', name, type: RETRIEVAL_TRACE_NODE_TYPE,
      properties: { explanation }, frequency: 0,
      createdAt, updatedAt: createdAt,
    }
  }

  it('按创建时间倒序返回且过滤无解释节点', async () => {
    const old = makeNode('t1', '旧', new Date(1000), makeExplanation())
    const newer = makeNode('t2', '新', new Date(2000), makeExplanation())
    const noExp = makeNode('t3', '无解释', new Date(3000), null)

    const graph = {
      findNodesByType: mock(async () => [old, noExp, newer]),
    } as unknown as GraphDB

    const traces = await listRetrievalTraces(graph, 'kb_1', 10)
    expect(traces.map((t: any) => t.id)).toEqual(['t2', 't1'])
    expect(traces[0].explanation?.focus).toHaveLength(1)
  })

  it('limit 生效', async () => {
    const nodes = [1, 2, 3].map((i) =>
      makeNode(`t${i}`, `n${i}`, new Date(i * 1000), makeExplanation())
    )
    const graph = {
      findNodesByType: mock(async () => nodes),
    } as unknown as GraphDB

    const traces = await listRetrievalTraces(graph, undefined, 2)
    expect(traces).toHaveLength(2)
  })
})

describe('updateTraceAnswer（对标 TrustGraph Synthesis 溯源回填）', () => {
  it('把答案写回 trace 节点的解释结构', async () => {
    const explanation = makeExplanation()
    const storedProps: Record<string, unknown> = {
      kind: 'retrieval_trace',
      queryText: 'q',
      explanation,
    }
    const graph = {
      getNode: mock(async () => ({
        id: 't1', properties: storedProps,
      })),
      updateNode: mock(async () => {}),
    } as unknown as GraphDB

    await updateTraceAnswer(graph, 't1', '退款流程是……')

    expect(explanation.answer).toBe('退款流程是……')
    expect(graph.updateNode).toHaveBeenCalledWith('t1', {
      properties: expect.objectContaining({ explanation }),
    })
  })

  it('trace 节点不存在时告警不抛错', async () => {
    const graph = {
      getNode: mock(async () => null),
      updateNode: mock(),
    } as unknown as GraphDB

    await expect(updateTraceAnswer(graph, 'missing', 'answer')).resolves.toBeUndefined()
    expect(graph.updateNode).not.toHaveBeenCalled()
  })

  it('没有 GraphRAG explanation 时也能回填 Document RAG 答案', async () => {
    const graph = {
      getNode: mock(async () => ({ id: 't1', properties: { stages: [] } })),
      updateNode: mock(async () => {}),
    } as unknown as GraphDB

    await updateTraceAnswer(graph, 't1', '文档答案')

    expect(graph.updateNode).toHaveBeenCalledWith('t1', {
      properties: { stages: [], answer: '文档答案' },
    })
  })
})

describe('persistRetrievalTrace', () => {
  it('将非 GraphRAG 检索阶段写入 retrieval 逻辑命名空间', async () => {
    const addNode = mock(async (input: { id: string }) => input.id)
    const graph = { addNode } as unknown as GraphDB

    const id = await persistRetrievalTrace(graph, {
      queryText: '文档问题',
      knowledgeBaseId: 'kb_1',
      source: 'document',
      stages: { exploration: ['chunk-1'] },
    })

    expect(id).toBeTypeOf('string')
    expect(addNode).toHaveBeenCalledWith(expect.objectContaining({
      knowledgeBaseId: '__retrieval__:kb_1',
      properties: expect.objectContaining({
        source: 'document',
        graphName: 'urn:graph:retrieval',
      }),
    }))
  })

  it('优先使用物理 retrieval trace 存储，不污染 graph_nodes', async () => {
    const storeRetrievalTrace = mock(async (input: { id: string }) => input.id)
    const addNode = mock()
    const graph = { storeRetrievalTrace, addNode } as unknown as GraphDB

    await persistRetrievalTrace(graph, {
      queryText: '物理隔离',
      knowledgeBaseId: 'kb_1',
      source: 'unified',
      stages: { grounding: ['doc-1'] },
    })

    expect(storeRetrievalTrace).toHaveBeenCalledTimes(1)
    expect(addNode).not.toHaveBeenCalled()
  })
})

describe('traceEdgeProvenance（对标 TrustGraph 审计链贯通查询）', () => {
  function makeNode(id: string, name: string) {
    return { id, knowledgeBaseId: 'kb', name, type: 'entity', properties: {}, frequency: 1, createdAt: new Date(), updatedAt: new Date() }
  }

  it('双通道汇聚：边文档来源 + 节点 chunk/page 明细 + 节点名解析', async () => {
    const sourceNode = makeNode('n1', 'Python')
    const targetNode = makeNode('n2', 'pandas')
    const graph = {
      getEdges: mock(async () => [
        {
          sourceId: 'n1', targetId: 'n2', relationshipName: '用于',
          properties: { sourceDocumentIds: ['doc_42', 'doc_7'] },
          weight: 1, knowledgeBaseId: 'kb', createdAt: new Date(), updatedAt: new Date(),
        },
      ]),
      getProvenanceLinks: mock(async () => [
        { nodeId: 'n1', documentId: 'doc_42', chunkIndex: 3, pageIndex: 7, pipelineRunId: 'run1' },
        { nodeId: 'n2', documentId: 'doc_42', chunkIndex: 3, pageIndex: 7, pipelineRunId: null },
      ]),
      getNode: mock(async (id: string) => (id === 'n1' ? sourceNode : targetNode)),
    } as unknown as GraphDB

    const chain = await traceEdgeProvenance(graph, {
      sourceId: 'n1', targetId: 'n2', relationshipName: '用于',
    })

    expect(chain.documents).toEqual(['doc_42', 'doc_7'])
    expect(chain.nodeProvenance).toHaveLength(2)
    expect(chain.nodeProvenance[0]).toMatchObject({
      nodeName: 'Python',
      documentId: 'doc_42',
      chunkIndex: 3,
      pageIndex: 7,
    })
    expect(chain.nodeProvenance[1].nodeName).toBe('pandas')
  })

  it('不支持 getProvenanceLinks 的适配器：慢路径为空、快路径仍可用', async () => {
    const graph = {
      getEdges: mock(async () => [
        {
          sourceId: 'a', targetId: 'b', relationshipName: 'r',
          properties: { sourceDocumentIds: ['doc_1'] },
          weight: 1, knowledgeBaseId: 'kb', createdAt: new Date(), updatedAt: new Date(),
        },
      ]),
    } as unknown as GraphDB

    const chain = await traceEdgeProvenance(graph, { sourceId: 'a', targetId: 'b', relationshipName: 'r' })
    expect(chain.documents).toEqual(['doc_1'])
    expect(chain.nodeProvenance).toEqual([])
  })

  it('getEdges 抛错时不抛异常，返回空链', async () => {
    const graph = {
      getEdges: mock(async () => { throw new Error('db down') }),
    } as unknown as GraphDB

    const chain = await traceEdgeProvenance(graph, { sourceId: 'a', targetId: 'b', relationshipName: 'r' })
    expect(chain.documents).toEqual([])
    expect(chain.nodeProvenance).toEqual([])
  })
})

describe('createGraphTracePersister 返回 traceId', () => {
  it('返回写入节点的 id 供答案回填', async () => {
    const graph = {
      addNode: mock(async (input) => input.id),
    } as unknown as GraphDB

    const traceId = await createGraphTracePersister(graph)(makeExplanation(), { queryText: 'q' })
    expect(traceId).toBeTypeOf('string')
    expect((traceId as string).length).toBeGreaterThan(0)
  })
})
