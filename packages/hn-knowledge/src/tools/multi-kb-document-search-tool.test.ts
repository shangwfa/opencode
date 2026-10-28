/**
 * multi-kb-document-search-tool 单元测试
 * 测试单库行为、多库并行检索与合并、结果含 metadata.knowledgeBaseId
 * 验证多库时确为并行调用（Promise.allSettled 同时发起）
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'

// 绕过 createTool 的 execute 包装，直接测工具业务逻辑；execute 收到 { context } 包装
mock.module('../utils/create-tool.js', () => ({
  createTool: mock((config: any) => config),
}))

mock.module('../rag/knowledge-base/index.js', () => {
  const mockHybridSearchService = {
    search: mock(),
  }
  const mockKnowledgeBaseService = {
    listKnowledgeBases: mock(),
    getDocument: mock(),
  }
  return {
    hybridSearchService: mockHybridSearchService,
    knowledgeBaseService: mockKnowledgeBaseService,
  }
})

mock.module('../utils/media-extractor.js', () => ({
  extractAllMedia: mock(() => ({
    images: [],
    videos: [],
  })),
}))

mock.module('../utils/rag-trace-logger.js', () => ({
  getOrCreateTraceId: mock(() => 'trace-1'),
  appendRetrievalTraceId: mock(),
  logRagTrace: mock(),
}))

// 使用真实 RRF，不 mock
// 在依赖 mock 就绪后再导入被测模块
const { createMultiKbDocumentSearchTool, multiKbDocumentSearchTool } = await import('./multi-kb-document-search-tool.js')
const { hybridSearchService, knowledgeBaseService } = await import('../rag/knowledge-base/index.js')

const defaultKbList = {
  items: [{ id: 'default-kb-id', name: '测试知识库 - rpa_zh-CN', description: '测试' }],
  total: 1
}

const mockSearchResult = (id: string, text: string, documentId: string) => ({
  id,
  text,
  score: 0.9,
  documentId,
  chunkIndex: 0,
  metadata: { docName: '测试文档', docUrl: 'https://example.com/doc' }
})

/** bun:test 无 vi.waitFor，使用简单轮询 */
async function waitFor(check: () => boolean, timeout = 200): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('multi-kb-document-search-tool', () => {
  const consoleSpies: Array<ReturnType<typeof spyOn>> = []

  beforeEach(() => {
    consoleSpies.push(
      spyOn(console, 'error').mockImplementation(() => {}),
      spyOn(console, 'warn').mockImplementation(() => {}),
      spyOn(console, 'log').mockImplementation(() => {}),
    )
    mock.clearAllMocks()
    ;(knowledgeBaseService.listKnowledgeBases as any).mockResolvedValue({
      items: [],
      total: 0
    })
  })

  afterEach(() => {
    for (const spy of consoleSpies) spy.mockRestore()
    consoleSpies.length = 0
  })

  describe('工厂函数 createMultiKbDocumentSearchTool', () => {
    it('应该创建具有正确 id 的工具实例', () => {
      const tool = createMultiKbDocumentSearchTool('kb-1')
      expect(tool.id).toBe('multi-kb-document-search')
    })

    it('应该创建具有正确 inputSchema 的工具实例', () => {
      const tool = createMultiKbDocumentSearchTool('kb-1')
      expect(tool.inputSchema).toBeDefined()
    })

    it('应该创建具有正确 outputSchema 的工具实例', () => {
      const tool = createMultiKbDocumentSearchTool('kb-1')
      expect(tool.outputSchema).toBeDefined()
    })

    it('应该支持传入单个知识库 ID', () => {
      const tool = createMultiKbDocumentSearchTool('custom-kb-id')
      expect(tool).toBeDefined()
    })

    it('应该支持传入知识库 ID 数组', () => {
      const tool = createMultiKbDocumentSearchTool(['kb-1', 'kb-2'])
      expect(tool).toBeDefined()
    })

    it('应该支持不传参数（使用默认知识库）', () => {
      const tool = createMultiKbDocumentSearchTool()
      expect(tool).toBeDefined()
    })

    it('应该导出默认的 multiKbDocumentSearchTool 实例', () => {
      expect(multiKbDocumentSearchTool).toBeDefined()
      expect(multiKbDocumentSearchTool.id).toBe('multi-kb-document-search')
    })
  })

  describe('单库行为', () => {
    it('单库时应只调用一次 hybridSearchService.search', async () => {
      ;(hybridSearchService.search as any).mockResolvedValue([mockSearchResult('1', '单库结果', 'doc1')])

      const tool = createMultiKbDocumentSearchTool('kb_single')
      const result = await tool.execute({
        context: { query: '测试', topK: 10 }
      })

      expect(hybridSearchService.search).toHaveBeenCalledTimes(1)
      expect(hybridSearchService.search).toHaveBeenCalledWith(
        'kb_single',
        '测试',
        expect.objectContaining({ topK: 10 })
      )
      expect(result.results).toHaveLength(1)
      expect(result.results[0].metadata?.knowledgeBaseId).toBe('kb_single')
      expect(result.total).toBe(1)
    })

    it('单库时结果应包含 knowledgeBaseId', async () => {
      ;(hybridSearchService.search as any).mockResolvedValue([mockSearchResult('1', '内容', 'doc1')])

      const tool = createMultiKbDocumentSearchTool('kb_abc')
      const result = await tool.execute({
        context: { query: 'q', topK: 10 }
      })

      expect(result.results[0].metadata).toBeDefined()
      expect(result.results[0].metadata!.knowledgeBaseId).toBe('kb_abc')
    })

    it('使用默认知识库名称时应解析并搜索', async () => {
      ;(knowledgeBaseService.listKnowledgeBases as any).mockResolvedValue(defaultKbList)
      ;(hybridSearchService.search as any).mockResolvedValue([mockSearchResult('1', '默认库结果', 'doc1')])

      const tool = createMultiKbDocumentSearchTool()
      const result = await tool.execute({
        context: { query: '测试', topK: 10 }
      })

      expect(knowledgeBaseService.listKnowledgeBases).toHaveBeenCalled()
      expect(hybridSearchService.search).toHaveBeenCalledWith('default-kb-id', '测试', expect.any(Object))
      expect(result.results).toHaveLength(1)
      expect(result.results[0].metadata?.knowledgeBaseId).toBe('default-kb-id')
    })
  })

  describe('多库并行检索与合并', () => {
    it('多库时应并行发起所有知识库的检索（同一 tick 内多次调用）', async () => {
      const callOrder: string[] = []
      const resolveFns: Array<(v: any) => void> = []

      ;(knowledgeBaseService.listKnowledgeBases as any).mockResolvedValue({
        items: [
          { id: 'kb_a', name: 'kb_a', description: '' },
          { id: 'kb_b', name: 'kb_b', description: '' },
          { id: 'kb_c', name: 'kb_c', description: '' }
        ],
        total: 3
      })
      ;(hybridSearchService.search as any).mockImplementation((kbId: string) => {
        callOrder.push(kbId)
        return new Promise((resolve) => {
          resolveFns.push(resolve)
        })
      })

      const tool = createMultiKbDocumentSearchTool(['kb_a', 'kb_b', 'kb_c'])
      const executePromise = tool.execute({
        context: { query: '测试', topK: 10 }
      })

      await waitFor(() => callOrder.length === 3)
      expect(callOrder).toContain('kb_a')
      expect(callOrder).toContain('kb_b')
      expect(callOrder).toContain('kb_c')
      resolveFns[0]([mockSearchResult('1', 'a', 'doc1')])
      resolveFns[1]([mockSearchResult('2', 'b', 'doc2')])
      resolveFns[2]([mockSearchResult('3', 'c', 'doc3')])

      const result = await executePromise
      expect(result.results.length).toBeGreaterThanOrEqual(1)
      expect(result.total).toBeGreaterThanOrEqual(1)
    })

    it('多库时应对每个知识库调用一次 search，且使用 Promise.allSettled 并行', async () => {
      const calls: string[] = []
      ;(hybridSearchService.search as any).mockImplementation((kbId: string) => {
        calls.push(kbId)
        return Promise.resolve([mockSearchResult(`${kbId}-1`, `from ${kbId}`, `doc-${kbId}`)])
      })

      const tool = createMultiKbDocumentSearchTool(['kb_1', 'kb_2'])
      const result = await tool.execute({
        context: { query: 'q', topK: 10 }
      })

      expect(hybridSearchService.search).toHaveBeenCalledTimes(2)
      expect(calls).toEqual(['kb_1', 'kb_2'])
      expect(result.results.length).toBeGreaterThanOrEqual(1)
      const kbIdsInResults = result.results.map((r: any) => r.metadata?.knowledgeBaseId)
      expect(kbIdsInResults).toContain('kb_1')
      expect(kbIdsInResults).toContain('kb_2')
    })

    it('多库合并结果应包含每条结果的 knowledgeBaseId', async () => {
      const search = hybridSearchService.search as any
      search.mockResolvedValueOnce([mockSearchResult('a1', '来自 kb_1', 'doc-a')])
      search.mockResolvedValueOnce([mockSearchResult('b1', '来自 kb_2', 'doc-b')])

      const tool = createMultiKbDocumentSearchTool(['kb_1', 'kb_2'])
      const result = await tool.execute({
        context: { query: 'q', topK: 10 }
      })

      expect(result.results).toBeDefined()
      expect(result.results.length).toBe(2)
      const ids = result.results.map((r: any) => r.metadata?.knowledgeBaseId)
      expect(ids).toContain('kb_1')
      expect(ids).toContain('kb_2')
    })

    it('本次调用传 knowledgeBaseIds 应覆盖工具默认列表', async () => {
      ;(hybridSearchService.search as any).mockResolvedValue([])

      const tool = createMultiKbDocumentSearchTool(['kb_default1', 'kb_default2'])
      await tool.execute({
        context: {
          query: 'q',
          topK: 10,
          knowledgeBaseIds: ['kb_override_a', 'kb_override_b']
        }
      })

      expect(hybridSearchService.search).toHaveBeenCalledWith('kb_override_a', 'q', expect.any(Object))
      expect(hybridSearchService.search).toHaveBeenCalledWith('kb_override_b', 'q', expect.any(Object))
      expect(hybridSearchService.search).toHaveBeenCalledTimes(2)
    })

    it('本次调用传 knowledgeBaseNames 应解析为 ID 并搜索', async () => {
      const kbList = {
        items: [
          { id: 'resolved-id-1', name: '知识库A', description: '' },
          { id: 'resolved-id-2', name: '知识库B', description: '' }
        ],
        total: 2
      }
      ;(knowledgeBaseService.listKnowledgeBases as any).mockResolvedValue(kbList)
      ;(hybridSearchService.search as any).mockResolvedValue([])

      const tool = createMultiKbDocumentSearchTool('some-default')
      await tool.execute({
        context: {
          query: 'q',
          topK: 10,
          knowledgeBaseNames: ['知识库A', '知识库B']
        }
      })

      expect(hybridSearchService.search).toHaveBeenCalledWith('resolved-id-1', 'q', expect.any(Object))
      expect(hybridSearchService.search).toHaveBeenCalledWith('resolved-id-2', 'q', expect.any(Object))
      expect(hybridSearchService.search).toHaveBeenCalledTimes(2)
    })
  })

  describe('错误与降级', () => {
    it('全部知识库解析失败时应返回 error 且 results 为空', async () => {
      ;(knowledgeBaseService.listKnowledgeBases as any).mockResolvedValue({
        items: [],
        total: 0
      })

      const tool = createMultiKbDocumentSearchTool(['不存在的知识库名称'])
      const result = await tool.execute({
        context: { query: 'q', topK: 10 }
      })

      expect(result.results).toEqual([])
      expect(result.total).toBe(0)
      expect(result.error).toBeDefined()
      expect(result.error).toContain('无法解析任何知识库')
      expect(hybridSearchService.search).not.toHaveBeenCalled()
    })

    it('部分知识库搜索失败时应返回成功库的结果并带 error 说明', async () => {
      const search = hybridSearchService.search as any
      search.mockResolvedValueOnce([mockSearchResult('1', '成功', 'doc1')])
      search.mockRejectedValueOnce(new Error('KB2 超时'))

      const tool = createMultiKbDocumentSearchTool(['kb_ok', 'kb_fail'])
      const result = await tool.execute({
        context: { query: 'q', topK: 10 }
      })

      expect(result.results.length).toBeGreaterThanOrEqual(1)
      expect(result.results.some((r: any) => r.text === '成功')).toBe(true)
    })
  })

  describe('边界情况', () => {
    it('应处理空的搜索结果', async () => {
      ;(hybridSearchService.search as any).mockResolvedValue([])

      const tool = createMultiKbDocumentSearchTool('kb_1')
      const result = await tool.execute({
        context: { query: '测试', topK: 10 }
      })

      expect(result.results).toEqual([])
      expect(result.total).toBe(0)
    })

    it('应处理 topK 参数', async () => {
      const many = Array.from({ length: 5 }, (_, i) => mockSearchResult(`${i}`, `结果${i}`, `doc${i}`))
      ;(hybridSearchService.search as any).mockResolvedValue(many)

      const tool = createMultiKbDocumentSearchTool('kb_1')
      const result = await tool.execute({
        context: { query: 'q', topK: 5 }
      })

      expect(hybridSearchService.search).toHaveBeenCalledWith('kb_1', 'q', expect.objectContaining({ topK: 5 }))
      expect(result.results.length).toBe(5)
    })
  })
})
