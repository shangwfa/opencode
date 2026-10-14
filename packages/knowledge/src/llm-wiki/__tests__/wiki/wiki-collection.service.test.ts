import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test'
import type { WikiCollection } from '../../types/wiki.types.js'

mock.module('../../db/index.js', () => {
  const mockDb = {
    insert: mock(),
    select: mock(),
    update: mock(),
    delete: mock()
  }

  const mockWikiCollections = {
    id: 'id',
    knowledgeBaseId: 'knowledge_base_id',
    name: 'name',
    status: 'status',
    lastCompiledAt: 'last_compiled_at',
    conceptCount: 'concept_count',
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  }

  const mockWikiConcepts = {
    id: 'id',
    collectionId: 'collection_id',
    conceptName: 'concept_name',
    slug: 'slug',
    definition: 'definition',
    summary: 'summary',
    content: 'content',
    tags: 'tags',
    occurrenceCount: 'occurrence_count',
    status: 'status',
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  }

  const mockWikiConceptSources = {
    id: 'id',
    conceptId: 'concept_id',
    documentId: 'document_id',
    contentHash: 'content_hash',
    compiledAt: 'compiled_at'
  }

  const mockWikiRelationships = {
    id: 'id',
    collectionId: 'collection_id',
    sourceConceptId: 'source_concept_id',
    targetConceptId: 'target_concept_id',
    relationshipType: 'relationship_type',
    strength: 'strength',
    createdAt: 'created_at'
  }

  const mockWikiCompileTasks = {
    id: 'id',
    collectionId: 'collection_id',
    knowledgeBaseId: 'knowledge_base_id',
    status: 'status',
    progress: 'progress',
    error: 'error',
    startedAt: 'started_at',
    completedAt: 'completed_at',
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  }

  return {
    db: mockDb,
    pool: { query: mock(() => ({ rows: [] })) },
    schemaName: 'test',
    documents: {},
    wikiCollections: mockWikiCollections,
    wikiConcepts: mockWikiConcepts,
    wikiConceptSources: mockWikiConceptSources,
    wikiRelationships: mockWikiRelationships,
    wikiCompileTasks: mockWikiCompileTasks
  }
})

mock.module('drizzle-orm', () => ({
  eq: mock((field: any, value: any) => ({ field, value })),
  desc: mock((field: any) => ({ field, order: 'desc' })),
  sql: mock((template: any, params?: any[]) => ({ template, params }))
}))

// bun test：mock.module 不提升，被测模块与被 mock 模块统一用 top-level await 动态 import
const { WikiCollectionService } = await import('../../services/wiki-collection.service.js')
const dbMod: any = await import('../../db/index.js')
const db = dbMod.db
const wikiCollections = dbMod.wikiCollections
const { eq, desc, sql } = await import('drizzle-orm')

describe('WikiCollectionService', () => {
  let service: any

  beforeEach(() => {
    mock.clearAllMocks()
    service = new WikiCollectionService()
  })

  describe('createCollection', () => {
    it('应该成功创建 Wiki 集合', async () => {
      const mockResult = {
        id: 'wiki_col_1234567890_abc123',
        knowledgeBaseId: 'kb_123',
        name: '测试集合',
        status: 'active',
        lastCompiledAt: null,
        conceptCount: 0,
        createdAt: new Date(),
        updatedAt: new Date()
      }

      const mockInsertChain = {
        values: mock().mockReturnThis(),
        returning: mock().mockResolvedValue([mockResult])
      }

      db.insert.mockReturnValue(mockInsertChain as any)

      const result = await service.createCollection('kb_123', '测试集合')

      expect(result).toEqual({
        id: 'wiki_col_1234567890_abc123',
        knowledgeBaseId: 'kb_123',
        name: '测试集合',
        status: 'active',
        conceptCount: 0,
        createdAt: mockResult.createdAt,
        updatedAt: mockResult.updatedAt
      })

      expect(db.insert).toHaveBeenCalled()
      expect(mockInsertChain.values).toHaveBeenCalled()
      expect(mockInsertChain.returning).toHaveBeenCalled()
    })

    it('创建时如果知识库已有集合应该抛出错误', async () => {
      const mockInsertChain = {
        values: mock().mockReturnThis(),
        returning: mock().mockRejectedValue(new Error('unique constraint violation'))
      }

      db.insert.mockReturnValue(mockInsertChain as any)

      await expect(service.createCollection('kb_123')).rejects.toThrow()
    })
  })

  describe('getCollection', () => {
    it('应该按 ID 获取集合', async () => {
      const mockResult = {
        id: 'wiki_col_123',
        knowledgeBaseId: 'kb_123',
        name: '测试集合',
        status: 'active',
        lastCompiledAt: null,
        conceptCount: 5,
        createdAt: new Date(),
        updatedAt: new Date()
      }

      const mockSelectChain = {
        from: mock().mockReturnThis(),
        where: mock().mockResolvedValue([mockResult])
      }

      db.select.mockReturnValue(mockSelectChain as any)

      const result = await service.getCollection('wiki_col_123')

      expect(result).toEqual({
        id: 'wiki_col_123',
        knowledgeBaseId: 'kb_123',
        name: '测试集合',
        status: 'active',
        conceptCount: 5,
        createdAt: mockResult.createdAt,
        updatedAt: mockResult.updatedAt
      })

      expect(db.select).toHaveBeenCalled()
    })

    it('找不到集合时应该返回 null', async () => {
      const mockSelectChain = {
        from: mock().mockReturnThis(),
        where: mock().mockResolvedValue([])
      }

      db.select.mockReturnValue(mockSelectChain as any)

      const result = await service.getCollection('nonexistent')

      expect(result).toBeNull()
    })
  })

  describe('getCollectionByKnowledgeBaseId', () => {
    it('应该按知识库 ID 获取集合', async () => {
      const mockResult = {
        id: 'wiki_col_123',
        knowledgeBaseId: 'kb_123',
        name: '测试集合',
        status: 'active',
        lastCompiledAt: null,
        conceptCount: 5,
        createdAt: new Date(),
        updatedAt: new Date()
      }

      const mockSelectChain = {
        from: mock().mockReturnThis(),
        where: mock().mockResolvedValue([mockResult])
      }

      db.select.mockReturnValue(mockSelectChain as any)

      const result = await service.getCollectionByKnowledgeBaseId('kb_123')

      expect(result).toEqual({
        id: 'wiki_col_123',
        knowledgeBaseId: 'kb_123',
        name: '测试集合',
        status: 'active',
        conceptCount: 5,
        createdAt: mockResult.createdAt,
        updatedAt: mockResult.updatedAt
      })
    })

    it('知识库没有集合时应该返回 null', async () => {
      const mockSelectChain = {
        from: mock().mockReturnThis(),
        where: mock().mockResolvedValue([])
      }

      db.select.mockReturnValue(mockSelectChain as any)

      const result = await service.getCollectionByKnowledgeBaseId('kb_nonexistent')

      expect(result).toBeNull()
    })
  })

  describe('getOrCreateCollection', () => {
    it('集合存在时应该返回已有集合', async () => {
      const mockResult = {
        id: 'wiki_col_123',
        knowledgeBaseId: 'kb_123',
        name: '测试集合',
        status: 'active',
        lastCompiledAt: null,
        conceptCount: 5,
        createdAt: new Date(),
        updatedAt: new Date()
      }

      const mockSelectChain = {
        from: mock().mockReturnThis(),
        where: mock().mockResolvedValue([mockResult])
      }

      db.select.mockReturnValue(mockSelectChain as any)

      const result = await service.getOrCreateCollection('kb_123')

      expect(result).toEqual({
        id: 'wiki_col_123',
        knowledgeBaseId: 'kb_123',
        name: '测试集合',
        status: 'active',
        conceptCount: 5,
        createdAt: mockResult.createdAt,
        updatedAt: mockResult.updatedAt
      })
    })

    it('集合不存在时应该创建新集合', async () => {
      const mockNewResult = {
        id: 'wiki_col_new_123',
        knowledgeBaseId: 'kb_456',
        name: '新集合',
        status: 'active',
        lastCompiledAt: null,
        conceptCount: 0,
        createdAt: new Date(),
        updatedAt: new Date()
      }

      const mockSelectChain = {
        from: mock().mockReturnThis(),
        where: mock().mockResolvedValue([])
      }

      const mockInsertChain = {
        values: mock().mockReturnThis(),
        returning: mock().mockResolvedValue([mockNewResult])
      }

      db.select.mockReturnValue(mockSelectChain as any)
      db.insert.mockReturnValue(mockInsertChain as any)

      const result = await service.getOrCreateCollection('kb_456', '新集合')

      expect(result).toEqual({
        id: 'wiki_col_new_123',
        knowledgeBaseId: 'kb_456',
        name: '新集合',
        status: 'active',
        conceptCount: 0,
        createdAt: mockNewResult.createdAt,
        updatedAt: mockNewResult.updatedAt
      })
    })
  })

  describe('updateCollection', () => {
    it('应该更新集合状态', async () => {
      const mockResult = {
        id: 'wiki_col_123',
        knowledgeBaseId: 'kb_123',
        name: '测试集合',
        status: 'building',
        lastCompiledAt: null,
        conceptCount: 5,
        createdAt: new Date(),
        updatedAt: new Date()
      }

      const mockUpdateChain = {
        set: mock().mockReturnThis(),
        where: mock().mockReturnThis(),
        returning: mock().mockResolvedValue([mockResult])
      }

      db.update.mockReturnValue(mockUpdateChain as any)

      const result = await service.updateCollection('wiki_col_123', { status: 'building' })

      expect(result).toEqual({
        id: 'wiki_col_123',
        knowledgeBaseId: 'kb_123',
        name: '测试集合',
        status: 'building',
        conceptCount: 5,
        createdAt: mockResult.createdAt,
        updatedAt: mockResult.updatedAt
      })

      expect(db.update).toHaveBeenCalled()
      expect(mockUpdateChain.set).toHaveBeenCalled()
    })

    it('应该更新概念数量', async () => {
      const mockResult = {
        id: 'wiki_col_123',
        knowledgeBaseId: 'kb_123',
        name: '测试集合',
        status: 'active',
        lastCompiledAt: null,
        conceptCount: 10,
        createdAt: new Date(),
        updatedAt: new Date()
      }

      const mockUpdateChain = {
        set: mock().mockReturnThis(),
        where: mock().mockReturnThis(),
        returning: mock().mockResolvedValue([mockResult])
      }

      db.update.mockReturnValue(mockUpdateChain as any)

      const result = await service.updateCollection('wiki_col_123', { conceptCount: 10 })

      expect(result?.conceptCount).toBe(10)
    })

    it('集合不存在时应该返回 null', async () => {
      const mockUpdateChain = {
        set: mock().mockReturnThis(),
        where: mock().mockReturnThis(),
        returning: mock().mockResolvedValue([])
      }

      db.update.mockReturnValue(mockUpdateChain as any)

      const result = await service.updateCollection('nonexistent', { status: 'active' })

      expect(result).toBeNull()
    })
  })

  describe('deleteCollection', () => {
    it('应该删除集合', async () => {
      const mockDeleteChain = {
        where: mock().mockResolvedValue(undefined)
      }

      db.delete.mockReturnValue(mockDeleteChain as any)

      await expect(service.deleteCollection('wiki_col_123')).resolves.toBeUndefined()

      expect(db.delete).toHaveBeenCalled()
    })
  })

  describe('listCollections', () => {
    it('应该返回分页集合列表', async () => {
      const mockCollections = [
        {
          id: 'wiki_col_1',
          knowledgeBaseId: 'kb_1',
          name: '集合1',
          status: 'active',
          lastCompiledAt: null,
          conceptCount: 5,
          createdAt: new Date(),
          updatedAt: new Date()
        },
        {
          id: 'wiki_col_2',
          knowledgeBaseId: 'kb_2',
          name: '集合2',
          status: 'active',
          lastCompiledAt: null,
          conceptCount: 3,
          createdAt: new Date(),
          updatedAt: new Date()
        }
      ]

      const mockCountChain = {
        from: mock().mockReturnValue({ where: mock().mockResolvedValue([{ count: 2 }]) })
      }

      const mockSelectChain = {
        from: mock().mockReturnThis(),
        where: mock().mockReturnThis(),
        orderBy: mock().mockReturnThis(),
        limit: mock().mockReturnThis(),
        offset: mock().mockResolvedValue(mockCollections)
      }

      db.select        .mockReturnValueOnce(mockCountChain as any)
        .mockReturnValueOnce(mockSelectChain as any)

      const result = await service.listCollections({ page: 1, pageSize: 10 })

      expect(result.items).toHaveLength(2)
      expect(result.total).toBe(2)
      expect(result.page).toBe(1)
      expect(result.pageSize).toBe(10)
      expect(result.totalPages).toBe(1)
    })

    it('应该使用默认分页参数', async () => {
      const mockCountChain = {
        from: mock().mockReturnValue({ where: mock().mockResolvedValue([{ count: 0 }]) })
      }

      const mockSelectChain = {
        from: mock().mockReturnThis(),
        where: mock().mockReturnThis(),
        orderBy: mock().mockReturnThis(),
        limit: mock().mockReturnThis(),
        offset: mock().mockResolvedValue([])
      }

      db.select        .mockReturnValueOnce(mockCountChain as any)
        .mockReturnValueOnce(mockSelectChain as any)

      const result = await service.listCollections()

      expect(result.page).toBe(1)
      expect(result.pageSize).toBe(10)
    })
  })
})
