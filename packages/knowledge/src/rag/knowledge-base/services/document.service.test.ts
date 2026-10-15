/**
 * DocumentService 单元测试
 * 测试文档处理和分块功能
 */

import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test'

/** vi.mocked 的 bun 等价物：仅做类型断言，便于对 mock 函数调用 mock* 方法 */
const mocked = (fn: unknown): any => fn as any
type DocumentService = import('./document.service').DocumentService
let markdownChunkOutput = [{ text: 'chunk 1', metadata: { chunkIndex: 0 } }]

// Mock 依赖
mock.module('./vector.service', () => ({
  VectorService: class VectorService {}
}))
mock.module('./llm-semantic-chunk.service', () => ({
  LLMSemanticChunkService: class LLMSemanticChunkService {
    chunkByLLM = mock()
  }
}))

// Mock @mastra/rag
mock.module('@mastra/rag', () => ({
  MDocument: {
    fromText: mock().mockReturnValue({
      metadata: {},
      chunk: mock().mockResolvedValue([
        { text: 'chunk 1', metadata: { chunkIndex: 0 } },
        { text: 'chunk 2', metadata: { chunkIndex: 1 } }
      ])
    }),
    fromMarkdown: mock().mockReturnValue({
      metadata: {},
      chunk: mock(async () => markdownChunkOutput)
    }),
    fromHTML: mock().mockReturnValue({
      metadata: {},
      chunk: mock().mockResolvedValue([
        { text: 'chunk 1', metadata: { chunkIndex: 0 } }
      ])
    })
  }
}))

// Mock ai 模块（补齐全量导出，避免同进程其它测试文件的 import 链接失败）
mock.module('ai', () => ({
  embed: mock().mockResolvedValue({
    embedding: [0.1, 0.2, 0.3]
  }),
  embedMany: mock().mockResolvedValue({
    embeddings: [[0.1, 0.2, 0.3]]
  }),
  generateText: mock().mockResolvedValue({
    text: '0.8'
  }),
  generateObject: mock().mockResolvedValue({
    object: {}
  }),
  streamText: mock().mockResolvedValue({})
}))

// Mock @ai-sdk/openai
mock.module('@ai-sdk/openai', () => ({
  openai: {
    embedding: mock()
  },
  // providers/openai.ts 使用 createOpenAI 构造客户端（本地无法直连真实端点）
  createOpenAI: mock(() => {
    const provider = () => ({}) as any
    ;(provider as any).embedding = mock()
    ;(provider as any).chat = mock()
    ;(provider as any).textEmbedding = mock()
    return provider
  })
}))

// Mock media-extractor
mock.module('../../../utils/media-extractor.js', () => ({
  extractAllMedia: mock().mockReturnValue({
    images: [],
    videos: []
  })
}))

// 被测模块及其 mock 依赖：mock 注册后动态导入
const { DocumentService } = await import('./document.service')
const { embedMany } = await import('ai')

describe('DocumentService', () => {
  let documentService: DocumentService
  let mockVectorService: any

  beforeEach(() => {
    markdownChunkOutput = [{ text: 'chunk 1', metadata: { chunkIndex: 0 } }]
    mockVectorService = {
      indexChunks: mock().mockResolvedValue({ success: true, indexed: 5 }),
      query: mock().mockResolvedValue([]),
      createIndexForKnowledgeBase: mock().mockResolvedValue(true),
      upsertVectors: mock().mockResolvedValue({ success: true }),
      deleteByDocumentId: mock().mockResolvedValue(undefined),
      getDocumentVectorIds: mock().mockResolvedValue([]),
      getChunksByDocumentId: mock().mockResolvedValue([]),
      getChunkByIndex: mock().mockResolvedValue(null),
      countChunks: mock().mockResolvedValue(0),
      getAllChunksByKnowledgeBaseId: mock().mockResolvedValue({ chunks: [], total: 0 }),
      deleteIndex: mock().mockResolvedValue(undefined),
      deleteBatch: mock().mockResolvedValue(undefined),
      deleteByVectorId: mock().mockResolvedValue(undefined)
    } as any

    documentService = new DocumentService(mockVectorService, 'openai/text-embedding-3-small')
    mocked(embedMany).mockResolvedValue({ embeddings: [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]] })
    mock.clearAllMocks()
  })

  describe('初始化', () => {
    it('应该成功创建实例', () => {
      expect(documentService).toBeInstanceOf(DocumentService)
    })

    it('应该使用默认嵌入模型', () => {
      const service = new DocumentService(mockVectorService)
      expect(service).toBeInstanceOf(DocumentService)
    })

    it('应该支持自定义嵌入模型', () => {
      const service = new DocumentService(mockVectorService, 'custom-model')
      expect(service).toBeInstanceOf(DocumentService)
    })
  })

  describe('processDocument - 文本文档处理', () => {
    it('应该成功处理文本文档', async () => {
      const content = 'This is a test document.'
      const result = await documentService.processDocument(
        'kb1',
        content,
        'doc1',
        'text',
        'recursive'
      )
      expect(result.chunkCount).toBeGreaterThan(0)
      expect(mockVectorService.upsertVectors).toHaveBeenCalled()
    })

    it('应该使用默认chunk策略', async () => {
      const content = 'Test content'
      const result = await documentService.processDocument('kb1', content, 'doc1')

      expect(result).toBeDefined()
    })

    it('应该支持自定义chunk配置', async () => {
      const content = 'Test content'
      const chunkConfig = {
        chunkSize: 500,
        chunkOverlap: 50
      }

      const result = await documentService.processDocument(
        'kb1',
        content,
        'doc1',
        'recursive' as any,
        chunkConfig as any
      )

      expect(result).toBeDefined()
    })

    it('应该包含文档元数据', async () => {
      const content = 'Test content'
      const documentMetadata = { title: 'Test', author: 'Test Author' }

      const result = await documentService.processDocument(
        'kb1',
        content,
        'doc1',
        'text',
        'recursive',
        undefined,
        documentMetadata
      )

      expect(result).toBeDefined()
    })
  })

  describe('processDocument - Markdown文档处理', () => {
    it('应该成功处理Markdown文档', async () => {
      const content = '# Test\n\nThis is markdown content.'
      const result = await documentService.processDocument(
        'kb1',
        content,
        'doc1',
        'markdown'
      )

      expect(result).toBeDefined()
      expect(result.chunkCount).toBeGreaterThan(0)
    })

    it('应该从Markdown中提取媒体资源', async () => {
      const content = '![](image.png)\n\nContent'
      const result = await documentService.processDocument(
        'kb1',
        content,
        'doc1',
        'markdown'
      )

      expect(result).toBeDefined()
    })

    it('分块后必须保留 MDocument 返回的完整正文，不按估算位置截取原 Markdown', async () => {
      const content = '# 标题\n\n第一段完整内容，包含不可丢失的校验词甲。\n\n第二段也必须完整保留，校验词乙。'
      markdownChunkOutput = [
        { text: '标题 第一段完整内容，包含不可丢失的校验词甲。', metadata: { chunkIndex: 0 } },
        { text: '第二段也必须完整保留，校验词乙。', metadata: { chunkIndex: 1 } }
      ]

      await documentService.processDocument('kb1', content, 'doc1', 'markdown')

      const embeddedValues = mocked(embedMany).mock.calls.at(-1)?.[0].values
      expect(embeddedValues).toEqual(markdownChunkOutput.map((chunk) => chunk.text))
      expect(embeddedValues.join('\n')).toContain('校验词甲')
      expect(embeddedValues.join('\n')).toContain('校验词乙')
    })
  })

  describe('processDocument - HTML文档处理', () => {
    it('应该成功处理HTML文档', async () => {
      const content = '<html><body>Test content</body></html>'
      const result = await documentService.processDocument(
        'kb1',
        content,
        'doc1',
        'html'
      )

      expect(result).toBeDefined()
      expect(result.chunkCount).toBeGreaterThan(0)
    })
  })

  describe('processDocument - 自定义嵌入模型', () => {
    it('应该支持自定义嵌入模型', async () => {
      const content = 'Test content'
      const result = await documentService.processDocument(
        'kb1',
        content,
        'doc1',
        'text',
        'recursive',
        undefined,
        undefined,
        'custom-model'
      )

      expect(result).toBeDefined()
    })
  })

  describe('processDocument - 分块策略', () => {
    it('应该支持recursive分块', async () => {
      const content = 'Test content'
      const result = await documentService.processDocument(
        'kb1',
        content,
        'doc1',
        'text',
        'recursive'
      )

      expect(result).toBeDefined()
    })

    it('应该支持semantic分块', async () => {
      const longContent = 'a'.repeat(2000)
      const result = await documentService.processDocument(
        'kb1',
        longContent,
        'doc1',
        'text',
        'semantic' as any
      )

      expect(result).toBeDefined()
    })
  })

  describe('processDocument - 边界情况', () => {
    it('应该处理空内容', async () => {
      await expect(documentService.processDocument(
        'kb1',
        '',
        'doc1',
        'text'
      )).rejects.toThrow('Document content is empty')
    })

    it('应该处理非常短的内容', async () => {
      const result = await documentService.processDocument(
        'kb1',
        'Hi',
        'doc1',
        'text'
      )

      expect(result).toBeDefined()
    })

    it('应该处理特殊字符', async () => {
      const content = '测试\n\n内容🌍'
      const result = await documentService.processDocument(
        'kb1',
        content,
        'doc1',
        'text'
      )

      expect(result).toBeDefined()
    })
  })

  describe('processDocument - 错误处理', () => {
    it('应该处理嵌入生成失败', async () => {
      const { embedMany } = await import('ai')
      mocked(embedMany).mockRejectedValue(new Error('Embedding API error'))

      const content = 'Test content'
      await expect(documentService.processDocument(
        'kb1',
        content,
        'doc1',
        'text'
      )).rejects.toThrow('Embedding API error')
    })

    it('应该处理索引失败', async () => {
      mockVectorService.upsertVectors = mock().mockRejectedValue(new Error('Index error'))

      const content = 'Test content'
      await expect(documentService.processDocument(
        'kb1',
        content,
        'doc1',
        'text'
       )).rejects.toThrow('Index error')
    })
  })

  describe('processDocument - 元数据', () => {
    it('应该包含chunkIndex在metadata中', async () => {
      const content = 'Test content for chunking. More content here. Even more content.'
      const result = await documentService.processDocument(
        'kb1',
        content,
        'doc1',
        'text',
        'recursive'
      )

      expect(result.chunkCount).toBeGreaterThan(0)
    })

    it('应该保留文档元数据', async () => {
      const documentMetadata = { title: 'Test Doc', category: 'Test' }
      const content = 'Test content'

      const result = await documentService.processDocument(
        'kb1',
        content,
        'doc1',
        'text',
        'recursive',
        undefined,
        documentMetadata
      )

      expect(result).toBeDefined()
    })
  })

  describe('updateDocument - 两阶段提交', () => {
    it('应该先创建新向量，再删除旧向量', async () => {
       const oldVectorIds = ['doc1_0', 'doc1_1', 'doc1_old']
      const newVectorIds = ['doc1_0', 'doc1_1', 'doc1_2'] // 新向量数量可能不同

      mockVectorService.getDocumentVectorIds
        .mockResolvedValueOnce(oldVectorIds) // 第一次：获取旧向量ID
        .mockResolvedValueOnce(newVectorIds) // 第二次：验证新向量创建成功
      mockVectorService.deleteBatch.mockResolvedValue(undefined)

      // Mock processDocument 成功
      const { embedMany } = await import('ai')
      mocked(embedMany).mockResolvedValue({
        embeddings: [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6], [0.7, 0.8, 0.9]]
      })

      const result = await documentService.updateDocument(
        'kb1',
        'doc1',
        '新内容',
        'text',
        'recursive'
      )

      // 应该先获取旧向量ID
      expect(mockVectorService.getDocumentVectorIds).toHaveBeenCalledWith('kb1', 'doc1')
      // 应该创建新向量（通过 processDocument）
      expect(mockVectorService.upsertVectors).toHaveBeenCalled()
      // 应该验证新向量创建成功
      expect(mockVectorService.getDocumentVectorIds).toHaveBeenCalledTimes(2)
      // 应该删除旧向量（只删除不在新向量列表中的）
      expect(mockVectorService.deleteBatch).toHaveBeenCalled()
      expect(result.chunkCount).toBeGreaterThan(0)
    })

    it('应该在新向量创建失败时清理新向量', async () => {
      const oldVectorIds = ['doc1_0', 'doc1_1']
       const newVectorIds = ['doc1_0', 'doc1_2'] // 新向量创建不完整

      mockVectorService.getDocumentVectorIds
        .mockResolvedValueOnce(oldVectorIds) // 第一次：获取旧向量ID
        .mockResolvedValueOnce(newVectorIds) // 第二次：验证新向量（数量不足）
        .mockResolvedValueOnce(newVectorIds) // 第三次：清理时获取所有当前向量
      mockVectorService.deleteBatch.mockResolvedValue(undefined)

      // Mock processDocument 返回的 chunkCount
      const { embedMany } = await import('ai')
      mocked(embedMany).mockResolvedValue({
        embeddings: [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]] // 2个向量
      })

      await expect(
        documentService.updateDocument('kb1', 'doc1', '新内容', 'text', 'recursive')
      ).rejects.toThrow()

      // 应该尝试清理新创建的向量（通过 deleteBatch）
       expect(mockVectorService.deleteBatch).toHaveBeenCalledWith('kb1', ['doc1_2'])
    })

    it('应该在新文档（无旧向量）时正常工作', async () => {
      mockVectorService.getDocumentVectorIds.mockResolvedValueOnce([]) // 无旧向量
      mockVectorService.getDocumentVectorIds.mockResolvedValueOnce(['doc1_0', 'doc1_1']) // 新向量

      const { embedMany } = await import('ai')
      mocked(embedMany).mockResolvedValue({
        embeddings: [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]]
      })

      const result = await documentService.updateDocument(
        'kb1',
        'doc1',
        '新内容',
        'text',
        'recursive'
      )

      // 应该创建新向量
      expect(mockVectorService.upsertVectors).toHaveBeenCalled()
      // 不应该删除旧向量（因为没有旧向量）
      expect(mockVectorService.deleteBatch).not.toHaveBeenCalled()
      expect(result.chunkCount).toBeGreaterThan(0)
    })
  })
})
