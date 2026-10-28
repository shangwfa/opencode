import { describe, it, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test'

/** vi.mocked 的 bun 等价物：仅做类型断言，便于对 mock 函数调用 mock* 方法 */
const mocked = (fn: unknown): any => fn as any
type KnowledgeBaseService = import('./knowledge-base.service.js').KnowledgeBaseService
import type { CreateKnowledgeBaseRequest, ChunkStrategy } from '../types/knowledge-base.types'

// Mock数据库
mock.module('../../../db/index.js', () => {
  const mockDb = {
    insert: mock(),
    select: mock(),
    update: mock(),
    delete: mock()
  }

  const mockKnowledgeBases = {
    id: 'id',
    name: 'name',
    description: 'description',
    embeddingModel: 'embedding_model',
    defaultChunkStrategy: 'default_chunk_strategy',
    defaultChunkConfig: 'default_chunk_config',
    indexName: 'index_name',
    indexDimension: 'index_dimension',
    indexCreated: 'index_created',
    indexCreatedAt: 'index_created_at',
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  }

  const mockDocuments = {
    id: 'id',
    knowledgeBaseId: 'knowledge_base_id',
    content: 'content',
    type: 'type',
    chunkStrategy: 'chunk_strategy',
    chunkConfig: 'chunk_config',
    metadata: 'metadata',
    chunkCount: 'chunk_count',
    status: 'status',
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  }

  const mockPool = {
    connect: mock()
  }

  return {
    db: mockDb,
    knowledgeBases: mockKnowledgeBases,
    documents: mockDocuments,
    schemaName: 'test',
    pool: mockPool
  }
})

// Mock drizzle-orm
mock.module('drizzle-orm', () => ({
  eq: mock((field: any, value: any) => ({ field, value })),
  desc: mock((field: any) => ({ field, order: 'desc' })),
  asc: mock((field: any) => ({ field, order: 'asc' })),
  and: mock((...conditions: any[]) => ({ op: 'and', conditions })),
  or: mock(),
  ilike: mock(),
  sql: mock((template: any, params?: any[]) => ({ template, params }))
}))

// Mock VectorService
const mockVectorServiceInstance = {
  createIndex: mock().mockResolvedValue(undefined),
  deleteIndex: mock().mockResolvedValue(undefined),
  countChunks: mock().mockResolvedValue(0)
}

mock.module('./vector.service.js', () => ({
  VectorService: mock().mockImplementation(() => mockVectorServiceInstance)
}))

// Mock KeywordSearchService
const mockKeywordSearchServiceInstance = {
  createPerformanceIndexes: mock().mockResolvedValue(undefined)
}

mock.module('./keyword-search.service.js', () => ({
  KeywordSearchService: mock().mockImplementation(() => mockKeywordSearchServiceInstance)
}))

// Mock index-name utility
mock.module('../../../utils/index-name.js', () => ({
  getKnowledgeBaseIndexName: mock((id: string) => `kb_index_${id}`)
}))

// 导入mock后的模块（bun：mock.module 之后动态导入）
const { db, knowledgeBases, documents, pool } = await import('../../../db/index.js')
const { getKnowledgeBaseIndexName } = await import('../../../utils/index-name.js')
const { eq, desc } = await import('drizzle-orm')
const { KnowledgeBaseService } = await import('./knowledge-base.service.js')

describe('KnowledgeBaseService', () => {
  let service: KnowledgeBaseService
  let mockVectorService: any
  let mockKeywordSearchService: any

  beforeEach(() => {
    // 抑制console输出，避免测试输出混乱
    spyOn(console, 'error').mockImplementation(() => {})
    spyOn(console, 'warn').mockImplementation(() => {})
    spyOn(console, 'log').mockImplementation(() => {})

    // 重置所有mock
    mock.clearAllMocks()

    // 创建服务实例（使用mock的服务）
    mockVectorService = mockVectorServiceInstance
    mockKeywordSearchService = mockKeywordSearchServiceInstance
    service = new KnowledgeBaseService(mockVectorService, mockKeywordSearchService)

    // Mock getKnowledgeBaseStats 方法，避免在每个测试中设置复杂的 db.select mock
    spyOn(service as any, 'getKnowledgeBaseStats').mockResolvedValue({
      documentCount: 0,
      chunkCount: 0
    })
  })

  afterEach(() => {
    mock.restore()
  })

  describe('listDocuments 跨库隔离（where 条件不得被链式覆盖）', () => {
    it('主查询与计数查询均用 and 组合 knowledgeBaseId 与 status，且各只调用一次 where', async () => {
      const { and } = await import('drizzle-orm')

      const mainBuilder: any = {
        from: mock().mockReturnThis(),
        where: mock().mockReturnThis(),
        orderBy: mock().mockReturnThis(),
        limit: mock().mockReturnThis(),
        offset: mock().mockReturnValue([])
      }
      const countBuilder: any = {
        from: mock().mockReturnThis(),
        where: mock().mockReturnThis(),
        execute: mock().mockResolvedValue([{ count: 1 }])
      }
      mocked(db.select).mockImplementation(((selection?: any) =>
        selection && selection.count ? countBuilder : mainBuilder) as any)

      await service.listDocuments('kb_isolated', {})

      // 修复点：drizzle 的 .where() 链式调用是覆盖而非叠加，
      // 必须用 and() 组合后单次调用，否则 knowledgeBaseId 条件丢失导致跨库泄漏
      expect(and).toHaveBeenCalledTimes(1)
      expect(and).toHaveBeenCalledWith(
        { field: 'knowledge_base_id', value: 'kb_isolated' },
        { field: 'status', value: 'completed' }
      )
      expect(mainBuilder.where).toHaveBeenCalledTimes(1)
      expect(countBuilder.where).toHaveBeenCalledTimes(1)
      expect((mainBuilder.where.mock.calls[0] as any[])[0]?.op).toBe('and')
      expect(eq).toHaveBeenCalledWith(documents.knowledgeBaseId, 'kb_isolated')
      expect(eq).toHaveBeenCalledWith(documents.status, 'completed')
    })
  })

  describe('createKnowledgeBase', () => {
    it('应该成功创建知识库（自动生成ID）', async () => {
      const mockKB = {
        id: expect.any(String),
        name: '测试知识库',
        description: null,
        embeddingModel: 'openai/text-embedding-3-small',
        defaultChunkStrategy: 'recursive',
        defaultChunkConfig: { maxSize: 512, overlap: 50 },
        indexName: `kb_index_${expect.any(String)}`,
        indexDimension: 1536,
        indexCreated: 1,
        indexCreatedAt: expect.any(Date),
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date)
      }

      // Mock数据库插入
      const mockInsertChain = {
        values: mock().mockReturnThis(),
        returning: mock().mockResolvedValue([{
          id: 'kb_1234567890_abc123',
          name: '测试知识库',
          description: null,
          embeddingModel: 'openai/text-embedding-3-small',
          defaultChunkStrategy: 'recursive',
          defaultChunkConfig: { maxSize: 512, overlap: 50 },
          createdAt: new Date(),
          updatedAt: new Date()
        }])
      }
      mocked(db.insert).mockReturnValue(mockInsertChain as any)

      // Mock数据库更新
      const mockUpdateChain = {
        set: mock().mockReturnThis(),
        where: mock().mockResolvedValue(undefined)
      }
      mocked(db.update).mockReturnValue(mockUpdateChain as any)

      // Mock数据库查询
      const mockSelectChain = {
        from: mock().mockReturnThis(),
        where: mock().mockReturnThis(),
        limit: mock().mockResolvedValue([{
          id: 'kb_1234567890_abc123',
          name: '测试知识库',
          description: null,
          embeddingModel: 'openai/text-embedding-3-small',
          defaultChunkStrategy: 'recursive',
          defaultChunkConfig: { maxSize: 512, overlap: 50 },
          indexName: 'kb_index_kb_1234567890_abc123',
          indexDimension: 1536,
          indexCreated: 1,
          indexCreatedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date()
        }])
      }
      mocked(db.select).mockReturnValue(mockSelectChain as any)

      const request: CreateKnowledgeBaseRequest = {
        name: '测试知识库'
      } as any

      const result = await service.createKnowledgeBase(request)

      expect(result).toBeDefined()
      expect(result.name).toBe('测试知识库')
      expect(result.embeddingModel).toBe('openai/text-embedding-3-small')
      expect(result.indexDimension).toBe(1536)
      expect(result.indexCreated).toBe(true)
      expect(result.documentCount).toBe(0)
      expect(result.chunkCount).toBe(0)
      expect(mockVectorService.createIndex).toHaveBeenCalled()
      expect(mockKeywordSearchService.createPerformanceIndexes).toHaveBeenCalled()
    })

    it('应该成功创建知识库（使用自定义ID）', async () => {
      const customId = 'kb_custom_123'
      const mockInsertChain = {
        values: mock().mockReturnThis(),
        returning: mock().mockResolvedValue([{
          id: customId,
          name: '自定义ID知识库',
          description: '测试描述',
          embeddingModel: 'openai/text-embedding-3-small',
          defaultChunkStrategy: 'recursive',
          defaultChunkConfig: { maxSize: 512, overlap: 50 },
          createdAt: new Date(),
          updatedAt: new Date()
        }])
      }
      mocked(db.insert).mockReturnValue(mockInsertChain as any)

      const mockUpdateChain = {
        set: mock().mockReturnThis(),
        where: mock().mockResolvedValue(undefined)
      }
      mocked(db.update).mockReturnValue(mockUpdateChain as any)

      const mockSelectChain = {
        from: mock().mockReturnThis(),
        where: mock().mockReturnThis(),
        limit: mock().mockResolvedValue([{
          id: customId,
          name: '自定义ID知识库',
          description: '测试描述',
          embeddingModel: 'openai/text-embedding-3-small',
          defaultChunkStrategy: 'recursive',
          defaultChunkConfig: { maxSize: 512, overlap: 50 },
          indexName: `kb_index_${customId}`,
          indexDimension: 1536,
          indexCreated: 1,
          indexCreatedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date()
        }])
      }
      mocked(db.select).mockReturnValue(mockSelectChain as any)

      const request: CreateKnowledgeBaseRequest = {
        id: customId,
        name: '自定义ID知识库',
        description: '测试描述'
      } as any

      const result = await service.createKnowledgeBase(request)

      expect(result.id).toBe(customId)
      expect(mockVectorService.createIndex).toHaveBeenCalledWith(customId, 1536)
    })

    it('应该使用默认配置', async () => {
      const mockInsertChain = {
        values: mock().mockReturnThis(),
        returning: mock().mockResolvedValue([{
          id: 'kb_default',
          name: '默认配置',
          description: null,
          embeddingModel: 'openai/text-embedding-3-small',
          defaultChunkStrategy: 'recursive',
          defaultChunkConfig: { maxSize: 512, overlap: 50 },
          createdAt: new Date(),
          updatedAt: new Date()
        }])
      }
      mocked(db.insert).mockReturnValue(mockInsertChain as any)

      const mockUpdateChain = {
        set: mock().mockReturnThis(),
        where: mock().mockResolvedValue(undefined)
      }
      mocked(db.update).mockReturnValue(mockUpdateChain as any)

      const mockSelectChain = {
        from: mock().mockReturnThis(),
        where: mock().mockReturnThis(),
        limit: mock().mockResolvedValue([{
          id: 'kb_default',
          name: '默认配置',
          description: null,
          embeddingModel: 'openai/text-embedding-3-small',
          defaultChunkStrategy: 'recursive',
          defaultChunkConfig: { maxSize: 512, overlap: 50 },
          indexName: 'kb_index_kb_default',
          indexDimension: 1536,
          indexCreated: 1,
          indexCreatedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date()
        }])
      }
      mocked(db.select).mockReturnValue(mockSelectChain as any)

      const request: CreateKnowledgeBaseRequest = {
        name: '默认配置'
      } as any

      const result = await service.createKnowledgeBase(request)

      expect(result.embeddingModel).toBe('openai/text-embedding-3-small')
      expect(result.defaultChunkStrategy).toBe('recursive')
      expect(result.defaultChunkConfig).toEqual({ maxSize: 512, overlap: 50 })
    })

    it('应该在索引创建失败时标记失败状态', async () => {
      const mockInsertChain = {
        values: mock().mockReturnThis(),
        returning: mock().mockResolvedValue([{
          id: 'kb_failed',
          name: '索引失败',
          description: null,
          embeddingModel: 'openai/text-embedding-3-small',
          defaultChunkStrategy: 'recursive',
          defaultChunkConfig: { maxSize: 512, overlap: 50 },
          createdAt: new Date(),
          updatedAt: new Date()
        }])
      }
      mocked(db.insert).mockReturnValue(mockInsertChain as any)

      let updateCallCount = 0
      const mockUpdateChain = {
        set: mock().mockImplementation(function(this: any) {
          updateCallCount++
          return this
        }),
        where: mock().mockResolvedValue(undefined)
      }
      mocked(db.update).mockReturnValue(mockUpdateChain as any)

      // Mock向量索引创建失败
      mockVectorService.createIndex.mockRejectedValue(new Error('Index creation failed'))

      const request: CreateKnowledgeBaseRequest = {
        name: '索引失败'
      } as any

      await expect(service.createKnowledgeBase(request)).rejects.toThrow('Failed to create knowledge base')

      // 验证调用了update（标记失败状态）
      expect(db.update).toHaveBeenCalled()
    })

    it('应该在全文检索索引创建失败时继续成功', async () => {
      const mockInsertChain = {
        values: mock().mockReturnThis(),
        returning: mock().mockResolvedValue([{
          id: 'kb_partial',
          name: '部分失败',
          description: null,
          embeddingModel: 'openai/text-embedding-3-small',
          defaultChunkStrategy: 'recursive',
          defaultChunkConfig: { maxSize: 512, overlap: 50 },
          createdAt: new Date(),
          updatedAt: new Date()
        }])
      }
      mocked(db.insert).mockReturnValue(mockInsertChain as any)

      const mockUpdateChain = {
        set: mock().mockReturnThis(),
        where: mock().mockResolvedValue(undefined)
      }
      mocked(db.update).mockReturnValue(mockUpdateChain as any)

      const mockSelectChain = {
        from: mock().mockReturnThis(),
        where: mock().mockReturnThis(),
        limit: mock().mockResolvedValue([{
          id: 'kb_partial',
          name: '部分失败',
          description: null,
          embeddingModel: 'openai/text-embedding-3-small',
          defaultChunkStrategy: 'recursive',
          defaultChunkConfig: { maxSize: 512, overlap: 50 },
          indexName: 'kb_index_kb_partial',
          indexDimension: 1536,
          indexCreated: 1,
          indexCreatedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date()
        }])
      }
      mocked(db.select).mockReturnValue(mockSelectChain as any)

      // 重置向量索引mock（创建成功）
      mockVectorService.createIndex.mockReset()
      mockVectorService.createIndex.mockResolvedValue(undefined)

      // Mock全文检索索引创建失败
      mockKeywordSearchService.createPerformanceIndexes.mockReset()
      mockKeywordSearchService.createPerformanceIndexes.mockRejectedValue(
        new Error('Full-text index creation failed')
      )

      const request: CreateKnowledgeBaseRequest = {
        name: '部分失败'
      } as any

      const result = await service.createKnowledgeBase(request)

      // 应该成功创建知识库，即使全文检索索引失败
      expect(result).toBeDefined()
      expect(result.name).toBe('部分失败')
      expect(console.warn).toHaveBeenCalled()
    })
  })

  describe('listKnowledgeBases', () => {
    it('应该返回知识库列表（默认分页）', async () => {
      const mockKBs = [
        {
          id: 'kb_1',
          name: '知识库1',
          description: '描述1',
          embeddingModel: 'openai/text-embedding-3-small',
          defaultChunkStrategy: 'recursive',
          defaultChunkConfig: { maxSize: 512 },
          indexName: 'index_1',
          indexDimension: 1536,
          indexCreated: 1,
          indexCreatedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date()
        },
        {
          id: 'kb_2',
          name: '知识库2',
          description: null,
          embeddingModel: 'openai/text-embedding-3-small',
          defaultChunkStrategy: 'semantic',
          defaultChunkConfig: null,
          indexName: 'index_2',
          indexDimension: 1536,
          indexCreated: 1,
          indexCreatedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date()
        }
      ]

      // Mock select查询（模拟分页）
      mocked(db.select).mockReturnValue({
        from: mock().mockReturnThis(),
        where: mock().mockReturnThis(),
        orderBy: mock().mockReturnThis(),
        limit: mock().mockReturnThis(),
        offset: mock().mockResolvedValue(mockKBs),
        execute: mock().mockResolvedValue([{ count: 2 }])
      } as any)

      const result = await service.listKnowledgeBases()

      expect(result.items).toHaveLength(2)
      expect(result.total).toBe(2)
      expect(result.page).toBe(1)
      expect(result.pageSize).toBe(20)
      expect(result.totalPages).toBe(1)
    })

    it('应该支持分页参数', async () => {
      const mockKBs = [
        {
          id: 'kb_1',
          name: '知识库1',
          description: '描述1',
          embeddingModel: 'openai/text-embedding-3-small',
          defaultChunkStrategy: 'recursive',
          defaultChunkConfig: { maxSize: 512 },
          indexName: 'index_1',
          indexDimension: 1536,
          indexCreated: 1,
          indexCreatedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date()
        }
      ]

      mocked(db.select).mockReturnValue({
        from: mock().mockReturnThis(),
        where: mock().mockReturnThis(),
        orderBy: mock().mockReturnThis(),
        limit: mock().mockReturnThis(),
        offset: mock().mockResolvedValue(mockKBs),
        execute: mock().mockResolvedValue([{ count: 25 }])
      } as any)

      const result = await service.listKnowledgeBases({
        page: 2,
        pageSize: 10
      })

      expect(result.page).toBe(2)
      expect(result.pageSize).toBe(10)
      expect(result.totalPages).toBe(3) // 25 / 10 = 3页
    })

    it('应该支持搜索过滤', async () => {
      const mockKBs = [
        {
          id: 'kb_1',
          name: '测试知识库',
          description: '测试描述',
          embeddingModel: 'openai/text-embedding-3-small',
          defaultChunkStrategy: 'recursive',
          defaultChunkConfig: { maxSize: 512 },
          indexName: 'index_1',
          indexDimension: 1536,
          indexCreated: 1,
          indexCreatedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date()
        }
      ]

      mocked(db.select).mockReturnValue({
        from: mock().mockReturnThis(),
        where: mock().mockReturnThis(),
        orderBy: mock().mockReturnThis(),
        limit: mock().mockReturnThis(),
        offset: mock().mockResolvedValue(mockKBs),
        execute: mock().mockResolvedValue([{ count: 1 }])
      } as any)

      const result = await service.listKnowledgeBases({
        search: '测试'
      })

      expect(result.total).toBe(1)
      expect(result.items[0].name).toBe('测试知识库')
    })

    it('应该支持排序', async () => {
      const mockKBs = [
        {
          id: 'kb_1',
          name: 'A知识库',
          description: '描述1',
          embeddingModel: 'openai/text-embedding-3-small',
          defaultChunkStrategy: 'recursive',
          defaultChunkConfig: { maxSize: 512 },
          indexName: 'index_1',
          indexDimension: 1536,
          indexCreated: 1,
          indexCreatedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date()
        },
        {
          id: 'kb_2',
          name: 'B知识库',
          description: null,
          embeddingModel: 'openai/text-embedding-3-small',
          defaultChunkStrategy: 'semantic',
          defaultChunkConfig: null,
          indexName: 'index_2',
          indexDimension: 1536,
          indexCreated: 1,
          indexCreatedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date()
        }
      ]

      mocked(db.select).mockReturnValue({
        from: mock().mockReturnThis(),
        where: mock().mockReturnThis(),
        orderBy: mock().mockReturnThis(),
        limit: mock().mockReturnThis(),
        offset: mock().mockResolvedValue(mockKBs),
        execute: mock().mockResolvedValue([{ count: 2 }])
      } as any)

      const result = await service.listKnowledgeBases({
        orderBy: 'name',
        orderDirection: 'ASC'
      })

      expect(result.items).toHaveLength(2)
      expect(db.select).toHaveBeenCalled()
    })

    it('应该支持包含统计信息', async () => {
      const mockKBs = [
        {
          id: 'kb_1',
          name: '知识库1',
          description: '描述1',
          embeddingModel: 'openai/text-embedding-3-small',
          defaultChunkStrategy: 'recursive',
          defaultChunkConfig: { maxSize: 512 },
          indexName: 'index_1',
          indexDimension: 1536,
          indexCreated: 1,
          indexCreatedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date()
        }
      ]

      mocked(db.select).mockReturnValue({
        from: mock().mockReturnThis(),
        where: mock().mockReturnThis(),
        orderBy: mock().mockReturnThis(),
        limit: mock().mockReturnThis(),
        offset: mock().mockResolvedValue(mockKBs),
        execute: mock().mockResolvedValue([{ count: 1 }])
      } as any)

      // Mock getKnowledgeBaseStats 返回特定的统计值
      spyOn(service as any, 'getKnowledgeBaseStats').mockResolvedValue({
        documentCount: 10,
        chunkCount: 100
      })

      const result = await service.listKnowledgeBases({
        includeStats: true
      })

      expect(result.items[0]).toHaveProperty('documentCount', 10)
      expect(result.items[0]).toHaveProperty('chunkCount', 100)
      expect((service as any).getKnowledgeBaseStats).toHaveBeenCalledWith('kb_1')
    })

    it('应该返回空列表', async () => {
      mocked(db.select).mockReturnValue({
        from: mock().mockReturnThis(),
        where: mock().mockReturnThis(),
        orderBy: mock().mockReturnThis(),
        limit: mock().mockReturnThis(),
        offset: mock().mockResolvedValue([]),
        execute: mock().mockResolvedValue([{ count: 0 }])
      } as any)

      const result = await service.listKnowledgeBases()

      expect(result.items).toHaveLength(0)
      expect(result.total).toBe(0)
    })
  })

  describe('getKnowledgeBase', () => {
    it('应该返回知识库详情（包含统计信息）', async () => {
      const mockKB = {
        id: 'kb_123',
        name: '测试知识库',
        description: '测试描述',
        embeddingModel: 'openai/text-embedding-3-small',
        defaultChunkStrategy: 'recursive',
        defaultChunkConfig: { maxSize: 512, overlap: 50 },
        indexName: 'kb_index_kb_123',
        indexDimension: 1536,
        indexCreated: 1,
        indexCreatedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date()
      }

      // Mock getKnowledgeBaseStats 返回特定的统计值
      spyOn(service as any, 'getKnowledgeBaseStats').mockResolvedValue({
        documentCount: 15,
        chunkCount: 1250
      })

      const mockSelectChain = {
        from: mock().mockReturnThis(),
        where: mock().mockReturnThis(),
        limit: mock().mockResolvedValue([mockKB])
      }
      mocked(db.select).mockReturnValue(mockSelectChain as any)

      const result = await service.getKnowledgeBase('kb_123')

      expect(result).not.toBeNull()
      expect(result?.id).toBe('kb_123')
      expect(result?.name).toBe('测试知识库')
      expect(result?.description).toBe('测试描述')
      expect(result?.indexCreated).toBe(true)
      expect(result?.documentCount).toBe(15)
      expect(result?.chunkCount).toBe(1250)
      expect((service as any).getKnowledgeBaseStats).toHaveBeenCalledWith('kb_123')
    })

    it('应该对不存在的知识库返回null', async () => {
      const mockSelectChain = {
        from: mock().mockReturnThis(),
        where: mock().mockReturnThis(),
        limit: mock().mockResolvedValue([])
      }
      mocked(db.select).mockReturnValue(mockSelectChain as any)

      const result = await service.getKnowledgeBase('nonexistent')

      expect(result).toBeNull()
    })
  })

  describe('deleteKnowledgeBase', () => {
    it('应该删除知识库', async () => {
      const mockDeleteChain = {
        where: mock().mockResolvedValue(undefined)
      }
      mocked(db.delete).mockReturnValue(mockDeleteChain as any)

      await service.deleteKnowledgeBase('kb_123')

      expect(mockVectorService.deleteIndex).toHaveBeenCalledWith('kb_123')
      expect(db.delete).toHaveBeenCalled()
    })
  })

  describe('createDocument', () => {
    it('应该成功创建文档（自动生成ID）', async () => {
      const mockKB = {
        id: 'kb_123',
        name: '测试知识库',
        description: null,
        embeddingModel: 'openai/text-embedding-3-small',
        defaultChunkStrategy: 'semantic',
        defaultChunkConfig: { maxSize: 1024 },
        indexName: 'kb_index_kb_123',
        indexDimension: 1536,
        indexCreated: 1,
        indexCreatedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date()
      }

      const mockSelectChainForKB = {
        from: mock().mockReturnThis(),
        where: mock().mockReturnThis(),
        limit: mock().mockResolvedValue([mockKB])
      }
      mocked(db.select).mockReturnValue(mockSelectChainForKB as any)

      const mockDocument = {
        id: expect.any(String),
        knowledgeBaseId: 'kb_123',
        content: '这是测试内容',
        type: 'text',
        chunkStrategy: 'semantic',
        chunkConfig: { maxSize: 1024 },
        metadata: null,
        chunkCount: 0,
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date)
      }

      const mockInsertChain = {
        values: mock().mockReturnThis(),
        returning: mock().mockResolvedValue([{
          id: 'doc_1234567890_xyz789',
          knowledgeBaseId: 'kb_123',
          content: '这是测试内容',
          type: 'text',
          chunkStrategy: 'semantic',
          chunkConfig: { maxSize: 1024 },
          metadata: null,
          chunkCount: 0,
          createdAt: new Date(),
          updatedAt: new Date()
        }])
      }
      mocked(db.insert).mockReturnValue(mockInsertChain as any)

      const result = await service.createDocument(
        'kb_123',
        '这是测试内容',
        'text',
        undefined,
        undefined
      )

      expect(result).toBeDefined()
      expect(result.content).toBe('这是测试内容')
      expect(result.chunkStrategy).toBe('semantic' as any) // 使用知识库默认配置
    })

    it('应该成功创建文档（使用自定义ID）', async () => {
      const mockKB = {
        id: 'kb_123',
        name: '测试知识库',
        description: null,
        embeddingModel: 'openai/text-embedding-3-small',
        defaultChunkStrategy: 'recursive',
        defaultChunkConfig: { maxSize: 512, overlap: 50 },
        indexName: 'kb_index_kb_123',
        indexDimension: 1536,
        indexCreated: 1,
        indexCreatedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date()
      }

      let callCount = 0
      mocked(db.select).mockImplementation(() => {
        callCount++
        if (callCount === 1) {
          // 第一次调用：获取知识库
          return {
            from: mock().mockReturnThis(),
            where: mock().mockReturnThis(),
            limit: mock().mockResolvedValue([mockKB])
          } as any
        } else {
          // 第二次调用：检查文档是否存在（返回不存在）
          return {
            from: mock().mockReturnThis(),
            where: mock().mockReturnThis(),
            limit: mock().mockResolvedValue([])
          } as any
        }
      })

      const customId = 'doc_custom_123'
      const mockInsertChain = {
        values: mock().mockReturnThis(),
        returning: mock().mockResolvedValue([{
          id: customId,
          knowledgeBaseId: 'kb_123',
          content: '自定义文档',
          type: 'markdown',
          chunkStrategy: 'recursive',
          chunkConfig: { maxSize: 512, overlap: 50 },
          metadata: { key: 'value' },
          chunkCount: 0,
          createdAt: new Date(),
          updatedAt: new Date()
        }])
      }
      mocked(db.insert).mockReturnValue(mockInsertChain as any)

      const result = await service.createDocument(
        'kb_123',
        '自定义文档',
        'markdown',
        undefined,
        undefined,
        { key: 'value' },
        customId
      )

      expect(result.id).toBe(customId)
      expect(result.metadata).toEqual({ key: 'value' })
    })

    it('应该在知识库不存在时抛出异常', async () => {
      const mockSelectChain = {
        from: mock().mockReturnThis(),
        where: mock().mockReturnThis(),
        limit: mock().mockResolvedValue([])
      }
      mocked(db.select).mockReturnValue(mockSelectChain as any)

      await expect(
        service.createDocument('nonexistent_kb', '内容', 'text')
      ).rejects.toThrow('Knowledge base nonexistent_kb not found')
    })

    it('应该在ID已存在时抛出异常', async () => {
      const mockKB = {
        id: 'kb_123',
        name: '测试知识库',
        description: null,
        embeddingModel: 'openai/text-embedding-3-small',
        defaultChunkStrategy: 'recursive',
        defaultChunkConfig: { maxSize: 512, overlap: 50 },
        indexName: 'kb_index_kb_123',
        indexDimension: 1536,
        indexCreated: 1,
        indexCreatedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date()
      }

      let callCount = 0
      mocked(db.select).mockImplementation(() => {
        callCount++
        if (callCount === 1) {
          // 第一次调用：获取知识库
          return {
            from: mock().mockReturnThis(),
            where: mock().mockReturnThis(),
            limit: mock().mockResolvedValue([mockKB])
          } as any
        } else {
          // 第二次调用：检查文档是否存在
          return {
            from: mock().mockReturnThis(),
            where: mock().mockReturnThis(),
            limit: mock().mockResolvedValue([{
              id: 'doc_existing',
              knowledgeBaseId: 'kb_123',
              content: '已存在的文档',
              type: 'text',
              chunkStrategy: 'recursive',
              chunkConfig: { maxSize: 512, overlap: 50 },
              metadata: null,
              chunkCount: 0,
              createdAt: new Date(),
              updatedAt: new Date()
            }])
          } as any
        }
      })

      await expect(
        service.createDocument('kb_123', '新文档', 'text', undefined, undefined, undefined, 'doc_existing')
      ).rejects.toThrow('Document with id doc_existing already exists')
    })
  })

  describe('updateDocumentChunkCount', () => {
    it('应该更新文档块数量', async () => {
      const mockUpdateChain = {
        set: mock().mockReturnThis(),
        where: mock().mockResolvedValue(undefined)
      }
      mocked(db.update).mockReturnValue(mockUpdateChain as any)

      await service.updateDocumentChunkCount('doc_123', 10)

      expect(db.update).toHaveBeenCalled()
      const setCall = mocked(db.update).mock.results[0].value.set
      expect(setCall).toHaveBeenCalled()
    })
  })

  describe('listDocuments', () => {
    it('应该返回文档列表（默认分页）', async () => {
      const mockDocs = [
        {
          id: 'doc_1',
          knowledgeBaseId: 'kb_123',
          content: '内容1',
          type: 'text',
          chunkStrategy: 'recursive',
          chunkConfig: { maxSize: 512 },
          metadata: null,
          chunkCount: 5,
          createdAt: new Date(),
          updatedAt: new Date()
        },
        {
          id: 'doc_2',
          knowledgeBaseId: 'kb_123',
          content: '内容2',
          type: 'markdown',
          chunkStrategy: 'semantic',
          chunkConfig: null,
          metadata: { key: 'value' },
          chunkCount: 3,
          createdAt: new Date(),
          updatedAt: new Date()
        }
      ]

      let selectCallCount = 0
      mocked(db.select).mockImplementation((...args: any[]) => {
        selectCallCount++
        if (args.length > 0) {
          // COUNT查询 (有参数)
          return {
                from: mock().mockReturnValue({
                where: mock().mockReturnThis(),
                execute: mock().mockResolvedValue([{ count: 2 }])
            })
          } as any
        } else {
          // 文档查询 (无参数)
          const mockSelectChain = {
            from: mock().mockReturnThis(),
            where: mock().mockReturnThis(),
            orderBy: mock().mockReturnThis(),
            limit: mock().mockReturnThis(),
            offset: mock().mockResolvedValue(mockDocs)
          }
          return mockSelectChain as any
        }
      })

      const result = await service.listDocuments('kb_123')

      expect(result.items).toHaveLength(2)
      expect(result.total).toBe(2)
      expect(result.page).toBe(1)
      expect(result.pageSize).toBe(20)
      expect(result.totalPages).toBe(1)
      expect(result.items[0].id).toBe('doc_1')
      expect(result.items[1].type).toBe('markdown')
      expect(result.items[1].metadata).toEqual({ key: 'value' })
    })

    it('应该支持分页参数', async () => {
      const mockDocs = [{ id: 'doc_1', knowledgeBaseId: 'kb_123', content: '内容1', type: 'text' as const, chunkStrategy: 'recursive' as const, chunkConfig: null, metadata: null, chunkCount: 5, createdAt: new Date(), updatedAt: new Date() }]

      let selectCallCount = 0
      mocked(db.select).mockImplementation((...args: any[]) => {
        selectCallCount++
        if (args.length > 0) {
          return {
                from: mock().mockReturnValue({
                where: mock().mockReturnThis(),
                execute: mock().mockResolvedValue([{ count: 25 }])
            })
          } as any
        } else {
          return {
            from: mock().mockReturnThis(),
            where: mock().mockReturnThis(),
            orderBy: mock().mockReturnThis(),
            limit: mock().mockReturnThis(),
            offset: mock().mockResolvedValue(mockDocs)
          } as any
        }
      })

      const result = await service.listDocuments('kb_123', { page: 2, pageSize: 10 })

      expect(result.items).toHaveLength(1)
      expect(result.total).toBe(25)
      expect(result.page).toBe(2)
      expect(result.pageSize).toBe(10)
      expect(result.totalPages).toBe(3)
    })

    it('应该支持搜索过滤', async () => {
      let selectCallCount = 0
      mocked(db.select).mockImplementation((...args: any[]) => {
        selectCallCount++
        if (args.length > 0) {
          // COUNT查询需要支持两次where调用（第一次在构建countQuery，第二次在有搜索条件时）
          const countQueryMock = {
            from: mock().mockReturnThis(),
            where: mock().mockReturnThis(),
            execute: mock().mockResolvedValue([{ count: 1 }])
          }
          return countQueryMock as any
        } else {
          return {
            from: mock().mockReturnThis(),
            where: mock().mockReturnThis(),
            orderBy: mock().mockReturnThis(),
            limit: mock().mockReturnThis(),
            offset: mock().mockResolvedValue([
              {
                id: 'doc_api',
                knowledgeBaseId: 'kb_123',
                content: 'API文档内容',
                type: 'text',
                chunkStrategy: 'recursive',
                chunkConfig: null,
                metadata: null,
                chunkCount: 5,
                createdAt: new Date(),
                updatedAt: new Date()
              }
            ])
          } as any
        }
      })

      const result = await service.listDocuments('kb_123', { search: 'API' })

      expect(result.items).toHaveLength(1)
      expect(result.items[0].id).toBe('doc_api')
    })

    it('应该支持排序', async () => {
      let selectCallCount = 0
      mocked(db.select).mockImplementation((...args: any[]) => {
        selectCallCount++
        if (args.length > 0) {
          return {
                from: mock().mockReturnValue({
                where: mock().mockReturnThis(),
                execute: mock().mockResolvedValue([{ count: 2 }])
            })
          } as any
        } else {
          return {
            from: mock().mockReturnThis(),
            where: mock().mockReturnThis(),
            orderBy: mock().mockReturnThis(),
            limit: mock().mockReturnThis(),
            offset: mock().mockResolvedValue([])
          } as any
        }
      })

      const result = await service.listDocuments('kb_123', { orderBy: 'updatedAt', orderDirection: 'ASC' })

      expect(result.total).toBe(2)
    })

    it('应该返回空列表', async () => {
      let selectCallCount = 0
      mocked(db.select).mockImplementation((...args: any[]) => {
        selectCallCount++
        if (args.length > 0) {
          return {
                from: mock().mockReturnValue({
                where: mock().mockReturnThis(),
                execute: mock().mockResolvedValue([{ count: 0 }])
            })
          } as any
        } else {
          return {
            from: mock().mockReturnThis(),
            where: mock().mockReturnThis(),
            orderBy: mock().mockReturnThis(),
            limit: mock().mockReturnThis(),
            offset: mock().mockResolvedValue([])
          } as any
        }
      })

      const result = await service.listDocuments('kb_123')

      expect(result.items).toHaveLength(0)
      expect(result.total).toBe(0)
    })
  })

  describe('getDocument', () => {
    it('应该返回文档详情', async () => {
      const mockDoc = {
        id: 'doc_123',
        knowledgeBaseId: 'kb_123',
        content: '文档内容',
        type: 'html',
        chunkStrategy: 'recursive',
        chunkConfig: { maxSize: 512, overlap: 50 },
        metadata: { title: '测试' },
        chunkCount: 10,
        createdAt: new Date(),
        updatedAt: new Date()
      }

      const mockSelectChain = {
        from: mock().mockReturnThis(),
        where: mock().mockReturnThis(),
        limit: mock().mockResolvedValue([mockDoc])
      }
      mocked(db.select).mockReturnValue(mockSelectChain as any)

      const result = await service.getDocument('doc_123')

      expect(result).not.toBeNull()
      expect(result?.id).toBe('doc_123')
      expect(result?.content).toBe('文档内容')
      expect(result?.type).toBe('html')
      expect(result?.metadata).toEqual({ title: '测试' })
    })

    it('应该对不存在的文档返回null', async () => {
      const mockSelectChain = {
        from: mock().mockReturnThis(),
        where: mock().mockReturnThis(),
        limit: mock().mockResolvedValue([])
      }
      mocked(db.select).mockReturnValue(mockSelectChain as any)

      const result = await service.getDocument('nonexistent')

      expect(result).toBeNull()
    })
  })

  describe('updateDocument', () => {
    it('应该更新文档内容', async () => {
      const mockDoc = {
        id: 'doc_123',
        knowledgeBaseId: 'kb_123',
        content: '旧内容',
        type: 'text',
        chunkStrategy: 'recursive',
        chunkConfig: { maxSize: 512, overlap: 50 },
        metadata: null,
        chunkCount: 5,
        createdAt: new Date(),
        updatedAt: new Date()
      }

      const mockSelectChain = {
        from: mock().mockReturnThis(),
        where: mock().mockReturnThis(),
        limit: mock().mockResolvedValue([mockDoc])
      }
      mocked(db.select).mockReturnValue(mockSelectChain as any)

      const mockUpdateChain = {
        set: mock().mockReturnThis(),
        where: mock().mockResolvedValue(undefined)
      }
      mocked(db.update).mockReturnValue(mockUpdateChain as any)

      const result = await service.updateDocument('doc_123', '新内容')

      expect(db.update).toHaveBeenCalled()
    })

    it('应该在没有更新时直接返回文档', async () => {
      const mockDoc = {
        id: 'doc_123',
        knowledgeBaseId: 'kb_123',
        content: '内容',
        type: 'text',
        chunkStrategy: 'recursive',
        chunkConfig: { maxSize: 512, overlap: 50 },
        metadata: null,
        chunkCount: 5,
        createdAt: new Date(),
        updatedAt: new Date()
      }

      const mockSelectChain = {
        from: mock().mockReturnThis(),
        where: mock().mockReturnThis(),
        limit: mock().mockResolvedValue([mockDoc])
      }
      mocked(db.select).mockReturnValue(mockSelectChain as any)

      const result = await service.updateDocument('doc_123')

      expect(result).not.toBeNull()
      expect(result?.id).toBe('doc_123')
      expect(db.update).not.toHaveBeenCalled()
    })
  })

  describe('deleteDocument', () => {
    it('应该删除文档', async () => {
      const mockDeleteChain = {
        where: mock().mockResolvedValue(undefined)
      }
      mocked(db.delete).mockReturnValue(mockDeleteChain as any)

      await service.deleteDocument('doc_123')

      expect(db.delete).toHaveBeenCalled()
    })
  })

  describe('ensureKnowledgeBaseReady', () => {
    it('应该在索引已存在时不重复创建', async () => {
      const mockKB = {
        id: 'kb_123',
        name: '测试知识库',
        description: null,
        embeddingModel: 'openai/text-embedding-3-small',
        defaultChunkStrategy: 'recursive',
        defaultChunkConfig: { maxSize: 512, overlap: 50 },
        indexName: 'kb_index_kb_123',
        indexDimension: 1536,
        indexCreated: 1,
        indexCreatedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date()
      }

      const mockSelectChain = {
        from: mock().mockReturnThis(),
        where: mock().mockReturnThis(),
        limit: mock().mockResolvedValue([mockKB])
      }
      mocked(db.select).mockReturnValue(mockSelectChain as any)

      // Mock数据库连接，返回表已存在
      const mockClient = {
        query: mock().mockResolvedValue({
          rows: [{ exists: true }]
        }),
        release: mock()
      }
      mocked(pool.connect).mockResolvedValue(mockClient)

      await service.ensureKnowledgeBaseReady('kb_123')

      expect(mockVectorService.createIndex).not.toHaveBeenCalled()
      expect(mockClient.query).toHaveBeenCalled()
      expect(mockClient.release).toHaveBeenCalled()
    })

    it('应该在索引不存在时创建', async () => {
      const mockKB = {
        id: 'kb_123',
        name: '测试知识库',
        description: null,
        embeddingModel: 'openai/text-embedding-3-small',
        defaultChunkStrategy: 'recursive',
        defaultChunkConfig: { maxSize: 512, overlap: 50 },
        indexName: 'kb_index_kb_123',
        indexDimension: 1536,
        indexCreated: 0, // 未创建
        indexCreatedAt: null,
        createdAt: new Date(),
        updatedAt: new Date()
      }

      const mockSelectChain = {
        from: mock().mockReturnThis(),
        where: mock().mockReturnThis(),
        limit: mock().mockResolvedValue([mockKB])
      }
      mocked(db.select).mockReturnValue(mockSelectChain as any)

      // Mock数据库连接（第一次：检查表是否存在）
      let connectCallCount = 0
      mocked(pool.connect).mockImplementation(async () => {
        connectCallCount++
        if (connectCallCount === 1) {
          // 第一次调用：检查表是否存在（返回不存在）
          return {
            query: mock().mockResolvedValue({
              rows: [{ exists: false }]
            }),
            release: mock()
          }
        } else {
          // 第二次调用：验证表是否创建成功（返回已创建）
          return {
            query: mock().mockResolvedValue({
              rows: [{ exists: true }]
            }),
            release: mock()
          }
        }
      })

      // 重置mock，确保向量索引创建成功
      mockVectorService.createIndex.mockReset()
      mockVectorService.createIndex.mockResolvedValue(undefined)

      const mockUpdateChain = {
        set: mock().mockReturnThis(),
        where: mock().mockResolvedValue(undefined)
      }
      mocked(db.update).mockReturnValue(mockUpdateChain as any)

      await service.ensureKnowledgeBaseReady('kb_123')

      expect(mockVectorService.createIndex).toHaveBeenCalledWith('kb_123', 1536)
      expect(db.update).toHaveBeenCalled()
    })

    it('应该在知识库不存在时抛出异常', async () => {
      const mockSelectChain = {
        from: mock().mockReturnThis(),
        where: mock().mockReturnThis(),
        limit: mock().mockResolvedValue([])
      }
      mocked(db.select).mockReturnValue(mockSelectChain as any)

      await expect(service.ensureKnowledgeBaseReady('nonexistent')).rejects.toThrow(
        'Knowledge base not found: nonexistent'
      )
    })

    it('应该在索引创建失败时抛出异常', async () => {
      const mockKB = {
        id: 'kb_123',
        name: '测试知识库',
        description: null,
        embeddingModel: 'openai/text-embedding-3-small',
        defaultChunkStrategy: 'recursive',
        defaultChunkConfig: { maxSize: 512, overlap: 50 },
        indexName: 'kb_index_kb_123',
        indexDimension: 1536,
        indexCreated: 0,
        indexCreatedAt: null,
        createdAt: new Date(),
        updatedAt: new Date()
      }

      const mockSelectChain = {
        from: mock().mockReturnThis(),
        where: mock().mockReturnThis(),
        limit: mock().mockResolvedValue([mockKB])
      }
      mocked(db.select).mockReturnValue(mockSelectChain as any)

      const mockClient = {
        query: mock().mockResolvedValue({
          rows: [{ exists: false }]
        }),
        release: mock()
      }
      mocked(pool.connect).mockResolvedValue(mockClient)

      // Mock索引创建失败
      mockVectorService.createIndex.mockRejectedValue(new Error('Index creation failed'))

      const mockUpdateChain = {
        set: mock().mockReturnThis(),
        where: mock().mockResolvedValue(undefined)
      }
      mocked(db.update).mockReturnValue(mockUpdateChain as any)

      await expect(service.ensureKnowledgeBaseReady('kb_123')).rejects.toThrow(
        'Failed to create vector index'
      )
    })
  })
})
