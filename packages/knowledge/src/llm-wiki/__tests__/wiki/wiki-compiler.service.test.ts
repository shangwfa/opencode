import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test'
import { createHash } from 'crypto'
import type { WikiCollection } from '../../types/wiki.types.js'

mock.module('ai', () => ({
  embed: mock(async () => ({ embedding: [] })),
  embedMany: mock(async () => ({ embeddings: [] })),
  generateText: mock(async () => ({ text: '' })),
  generateObject: mock(async () => ({ object: {} })),
  streamText: mock(() => ({ textStream: (async function* () {})() })),
}))

// 源工程 mock '@ai-sdk/openai'（google provider 同理）；目标工程统一走 providers/llm 的 openaiChat
mock.module('../../../providers/llm.js', () => ({
  openaiChat: mock(() => 'mock-model'),
  openaiEmbedding: mock(() => 'mock-embedding-model'),
}))

mock.module('../../db/index.js', () => {
  const mockDb = {
    insert: mock(),
    select: mock(),
    update: mock(),
    delete: mock(),
    transaction: mock(async (fn: Function) => {
      const mockTx = {
        insert: mock(),
        select: mock(),
        update: mock(),
        delete: mock()
      }
      // 默认行为：tx 的方法返回与 db 相同的 mock 链
      mockTx.insert.mockReturnValue({ values: mock().mockResolvedValue(undefined) })
      mockTx.select.mockReturnValue({
        from: mock().mockReturnValue({
          where: mock().mockReturnValue({
            limit: mock().mockResolvedValue([])
          })
        })
      })
      mockTx.update.mockReturnValue({
        set: mock().mockReturnValue({
          where: mock().mockResolvedValue(undefined)
        })
      })
      return fn(mockTx)
    })
  }

  const mockDocuments = {
    id: 'id',
    knowledgeBaseId: 'knowledge_base_id',
    content: 'content',
    type: 'type',
    status: 'status',
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  }

  const mockWikiCollections = {
    id: 'id',
    knowledgeBaseId: 'knowledge_base_id',
    status: 'status',
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

  const mockWikiRelationships = {
    id: 'id',
    collectionId: 'collection_id',
    sourceConceptId: 'source_concept_id',
    targetConceptId: 'target_concept_id',
    relationshipType: 'relationship_type',
    strength: 'strength',
    createdAt: 'created_at'
  }

  return {
    db: mockDb,
    pool: { query: mock(() => ({ rows: [] })) },
    schemaName: 'test',
    documents: mockDocuments,
    wikiCollections: mockWikiCollections,
    wikiConcepts: mockWikiConcepts,
    wikiConceptSources: mockWikiConceptSources,
    wikiCompileTasks: mockWikiCompileTasks,
    wikiRelationships: mockWikiRelationships
  }
})

mock.module('drizzle-orm', () => ({
  eq: mock((field: any, value: any) => ({ field, value, type: 'eq' })),
  and: mock((...conditions: any[]) => ({ conditions, type: 'and' })),
  sql: mock((template: any, ...params: any[]) => ({ template, params }))
}))

// bun test：mock.module 不提升，被测模块与被 mock 模块统一用 top-level await 动态 import
const { WikiCompilerService } = await import('../../services/wiki-compiler.service.js')
const dbMod: any = await import('../../db/index.js')
const db = dbMod.db
// mock.module('ai') 后运行时是 mock 函数，断言用 any 规避真实类型
const generateText: any = (await import('ai')).generateText

describe('WikiCompilerService', () => {
  let service: any
  let mockWikiCollectionService: any
  let mockKnowledgeBaseService: any

  const mockCollection: WikiCollection = {
    id: 'wiki_col_test_123',
    knowledgeBaseId: 'kb_test_123',
    status: 'active',
    conceptCount: 0,
    createdAt: new Date(),
    updatedAt: new Date()
  }

  beforeEach(() => {
    mock.clearAllMocks()

    mockWikiCollectionService = {
      getOrCreateCollection: mock().mockResolvedValue(mockCollection),
      updateCollection: mock().mockResolvedValue(mockCollection)
    }

    mockKnowledgeBaseService = {}

    service = new WikiCompilerService(mockWikiCollectionService)
  })

  describe('compileKnowledgeBase', () => {
    it('应该成功创建编译任务并返回 taskId', async () => {
      const mockSelectChain = {
        from: mock().mockReturnThis(),
        where: mock().mockReturnThis(),
        limit: mock().mockResolvedValue([])
      }
      db.select.mockReturnValue(mockSelectChain as any)

      const mockInsertChain = {
        values: mock().mockResolvedValue([])
      }
      db.insert.mockReturnValue(mockInsertChain as any)

      const taskId = await service.compileKnowledgeBase('kb_test_123')

      expect(taskId).toMatch(/^wiki_task_/)
      expect(mockWikiCollectionService.getOrCreateCollection).toHaveBeenCalledWith('kb_test_123')
      expect(db.insert).toHaveBeenCalled()
      expect(mockInsertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({
          collectionId: mockCollection.id,
          knowledgeBaseId: 'kb_test_123',
          status: 'running'
        })
      )
    })

    it('当有正在运行的任务时应该抛出错误', async () => {
      const mockRunningTask = {
        id: 'wiki_task_existing',
        collectionId: mockCollection.id,
        status: 'running'
      }

      const mockSelectChain = {
        from: mock().mockReturnThis(),
        where: mock().mockReturnThis(),
        limit: mock().mockResolvedValue([mockRunningTask])
      }
      db.select.mockReturnValue(mockSelectChain as any)

      await expect(service.compileKnowledgeBase('kb_test_123')).rejects.toThrow(
        'already has a running compile task'
      )

      expect(db.insert).not.toHaveBeenCalled()
    })

    it('应该立即返回 taskId（不等待后台编译完成）', async () => {
      const mockSelectChain = {
        from: mock().mockReturnThis(),
        where: mock().mockReturnThis(),
        limit: mock().mockResolvedValue([])
      }
      db.select.mockReturnValue(mockSelectChain as any)

      const mockInsertChain = {
        values: mock().mockResolvedValue([])
      }
      db.insert.mockReturnValue(mockInsertChain as any)

      const startTime = Date.now()
      const taskId = await service.compileKnowledgeBase('kb_test_123')
      const elapsed = Date.now() - startTime

      expect(taskId).toBeDefined()
      expect(elapsed).toBeLessThan(500)
    })
  })

  describe('hasRunningTask', () => {
    it('当有正在运行的任务时应该返回 true', async () => {
      const mockRunningTask = {
        id: 'wiki_task_running',
        collectionId: mockCollection.id,
        status: 'running'
      }

      const mockSelectChain = {
        from: mock().mockReturnThis(),
        where: mock().mockReturnThis(),
        limit: mock().mockResolvedValue([mockRunningTask])
      }
      db.select.mockReturnValue(mockSelectChain as any)

      const result = await service.hasRunningTask(mockCollection.id)

      expect(result).toBe(true)
    })

    it('当没有正在运行的任务时应该返回 false', async () => {
      const mockSelectChain = {
        from: mock().mockReturnThis(),
        where: mock().mockReturnThis(),
        limit: mock().mockResolvedValue([])
      }
      db.select.mockReturnValue(mockSelectChain as any)

      const result = await service.hasRunningTask(mockCollection.id)

      expect(result).toBe(false)
    })

    it('数据库查询失败时应该抛出错误', async () => {
      const mockSelectChain = {
        from: mock().mockReturnThis(),
        where: mock().mockReturnThis(),
        limit: mock().mockRejectedValue(new Error('DB connection failed'))
      }
      db.select.mockReturnValue(mockSelectChain as any)

      await expect(service.hasRunningTask(mockCollection.id)).rejects.toThrow(
        'Failed to check running task'
      )
    })
  })

  describe('getCompileTask', () => {
    it('应该返回指定任务的状态', async () => {
      const mockTask = {
        id: 'wiki_task_test_123',
        collectionId: mockCollection.id,
        knowledgeBaseId: 'kb_test_123',
        status: 'completed',
        progress: { total: 5, processed: 5, skipped: 2, failed: 0, extracted: 10 },
        error: null,
        startedAt: new Date(),
        completedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date()
      }

      const mockSelectChain = {
        from: mock().mockReturnThis(),
        where: mock().mockResolvedValue([mockTask])
      }
      db.select.mockReturnValue(mockSelectChain as any)

      const result = await service.getCompileTask('wiki_task_test_123')

      expect(result).toEqual({
        id: 'wiki_task_test_123',
        collectionId: mockCollection.id,
        knowledgeBaseId: 'kb_test_123',
        status: 'completed',
        progress: { total: 5, processed: 5, skipped: 2, failed: 0, extracted: 10 },
        error: undefined,
        startedAt: mockTask.startedAt,
        completedAt: mockTask.completedAt,
        createdAt: mockTask.createdAt,
        updatedAt: mockTask.updatedAt
      })
    })

    it('任务不存在时应该返回 null', async () => {
      const mockSelectChain = {
        from: mock().mockReturnThis(),
        where: mock().mockResolvedValue([])
      }
      db.select.mockReturnValue(mockSelectChain as any)

      const result = await service.getCompileTask('nonexistent_task')

      expect(result).toBeNull()
    })
  })

  describe('extractConceptsWithRetry', () => {
    it('LLM 首次返回有效概念时应该直接返回，不触发重试', async () => {
      const validResponse = JSON.stringify({
        concepts: [
          {
            concept: '机器学习',
            summary: '一种通过数据训练模型的 AI 技术',
            is_new: true,
            tags: ['AI', '技术'],
            related_concepts: []
          }
        ]
      })

      generateText.mockResolvedValueOnce({ text: validResponse } as any)

      const result = await (service as any).extractConceptsWithRetry(
        '文档内容：介绍机器学习的基本概念...',
        [],
        'doc_001'
      )

      expect(result).toHaveLength(1)
      expect(result[0].concept).toBe('机器学习')
      expect(generateText).toHaveBeenCalledTimes(1)
    })

    it('LLM 返回畸形 JSON 时应该触发重试', async () => {
      const malformedResponse = '这不是有效的 JSON 格式，无法解析'
      const validResponse = JSON.stringify({
        concepts: [
          {
            concept: '深度学习',
            summary: '基于神经网络的机器学习技术',
            is_new: true,
            tags: ['AI'],
            related_concepts: []
          }
        ]
      })

      generateText        .mockResolvedValueOnce({ text: malformedResponse } as any)
        .mockResolvedValueOnce({ text: validResponse } as any)

      const result = await (service as any).extractConceptsWithRetry(
        '文档内容...',
        [],
        'doc_002'
      )

      expect(generateText).toHaveBeenCalledTimes(2)
      expect(result).toHaveLength(1)
      expect(result[0].concept).toBe('深度学习')
    })

    it('两次 LLM 调用都失败时应该返回 null', async () => {
      generateText.mockRejectedValue(new Error('API rate limit exceeded'))

      const result = await (service as any).extractConceptsWithRetry(
        '文档内容...',
        [],
        'doc_003'
      )

      expect(result).toBeNull()
      expect(generateText).toHaveBeenCalledTimes(1)
    })

    it('重试后仍返回空概念列表时应该返回空数组', async () => {
      const emptyResponse1 = '无效内容，无法解析为 JSON'
      const emptyResponse2 = '{ "concepts": [] }'

      generateText        .mockResolvedValueOnce({ text: emptyResponse1 } as any)
        .mockResolvedValueOnce({ text: emptyResponse2 } as any)

      const result = await (service as any).extractConceptsWithRetry(
        '文档内容...',
        [],
        'doc_004'
      )

      expect(generateText).toHaveBeenCalledTimes(2)
      expect(result).toEqual([])
    })
  })

  describe('storeConcept - 哈希比较和跳过逻辑', () => {
    it('概念不存在时应该插入新概念和来源记录', async () => {
      const mockSelectChainEmpty = {
        from: mock().mockReturnThis(),
        where: mock().mockReturnThis(),
        limit: mock().mockResolvedValue([]),
      }

      db.select        .mockReturnValueOnce(mockSelectChainEmpty as any)
        .mockReturnValueOnce(mockSelectChainEmpty as any)

      const mockInsertChain = {
        values: mock().mockResolvedValue([])
      }
      db.insert.mockReturnValue(mockInsertChain as any)

      const concept = {
        concept: '测试概念',
        summary: '这是测试概念的摘要',
        is_new: true,
        tags: ['测试'],
        related_concepts: []
      }

      await (service as any).storeConcept(concept, mockCollection.id, 'doc_001', 'hash_abc123')

      expect(db.insert).toHaveBeenCalledTimes(2)
    })

    it('概念已存在时应该更新 occurrence_count 而不是插入新记录', async () => {
      const existingConcept = {
        id: 'wiki_concept_existing',
        collectionId: mockCollection.id,
        conceptName: '已有概念',
        slug: 'existing-concept',
        occurrenceCount: 3
      }

      const mockSelectChainWithConcept = {
        from: mock().mockReturnThis(),
        where: mock().mockReturnThis(),
        limit: mock().mockResolvedValue([existingConcept]),
      }

      const mockSelectChainEmpty = {
        from: mock().mockReturnThis(),
        where: mock().mockReturnThis(),
        limit: mock().mockResolvedValue([]),
      }

      db.select        .mockReturnValueOnce(mockSelectChainWithConcept as any)
        .mockReturnValueOnce(mockSelectChainEmpty as any)

      const mockInsertChain = {
        values: mock().mockResolvedValue([])
      }
      db.insert.mockReturnValue(mockInsertChain as any)

      const mockUpdateChain = {
        set: mock().mockReturnThis(),
        where: mock().mockResolvedValue([])
      }
      db.update.mockReturnValue(mockUpdateChain as any)

      const concept = {
        concept: '已有概念',
        summary: '这个概念已经存在',
        is_new: false,
        tags: [],
        related_concepts: []
      }

      await (service as any).storeConcept(concept, mockCollection.id, 'doc_002', 'hash_def456')

      expect(db.insert).toHaveBeenCalledTimes(1)
      expect(db.update).toHaveBeenCalled()
      expect(mockUpdateChain.set).toHaveBeenCalledWith(
        expect.objectContaining({ occurrenceCount: 4 })
      )
    })
  })

  describe('Phase 2 - 页面生成', () => {
    it('generateConceptPage 成功时更新 content 字段', async () => {
      const validPageResponse = JSON.stringify({
        sections: [{ heading: '概述', content: '机器学习是一种 AI 技术。', sourceRefs: [] }],
        relatedConcepts: []
      })

      generateText.mockResolvedValueOnce({ text: validPageResponse } as any)

      const mockUpdateChain = {
        set: mock().mockReturnThis(),
        where: mock().mockResolvedValue([])
      }
      db.update.mockReturnValue(mockUpdateChain as any)

      const result = await service.generateConceptPage(
        'wiki_concept_001',
        '机器学习',
        ['文档内容：介绍机器学习的基本概念'],
        []
      )

      expect(result).toBe(true)
      expect(generateText).toHaveBeenCalledTimes(1)
      expect(db.update).toHaveBeenCalled()
      expect(mockUpdateChain.set).toHaveBeenCalledWith(
        expect.objectContaining({ updatedAt: expect.any(Date) })
      )
    })

    it('generateConceptPage LLM 返回无效内容时返回 false', async () => {
      generateText.mockResolvedValueOnce({ text: '这不是有效的 JSON 格式' } as any)

      const result = await service.generateConceptPage(
        'wiki_concept_002',
        '深度学习',
        ['文档内容'],
        []
      )

      expect(result).toBe(false)
      expect(db.update).not.toHaveBeenCalled()
    })

    it('buildRelationships 正确建立概念间关系', async () => {
      // 服务两次查询共用同一 select mock：
      // 1) select({...}).from().where() → await 得到概念数组（概念名→id 映射）
      // 2) select().from().where().limit(1) → 去重查询，limit 返回空数组（允许插入）
      // where 返回 thenable 伪链，同时兼容 await 与 .limit() 两种消费方式
      const conceptsInDb = [
        { id: 'concept_a', conceptName: '机器学习', slug: 'machine-learning' },
        { id: 'concept_b', conceptName: '深度学习', slug: 'deep-learning' }
      ]
      const mockSelectChain = {
        from: mock().mockReturnThis(),
        where: mock(() => ({
          then: (resolve: (rows: any[]) => unknown) => resolve(conceptsInDb),
          limit: mock().mockResolvedValue([])
        }))
      }
      db.select.mockReturnValue(mockSelectChain as any)

      const mockInsertChain = {
        values: mock().mockResolvedValue([])
      }
      db.insert.mockReturnValue(mockInsertChain as any)

      const concepts = [
        { id: 'concept_a', conceptName: '机器学习', relatedConcepts: [{ name: '深度学习', type: 'related' }] },
        { id: 'concept_b', conceptName: '深度学习', relatedConcepts: [{ name: '机器学习', type: 'related' }] }
      ]

      await service.buildRelationships('col_001', concepts)

      expect(db.insert).toHaveBeenCalled()
      expect(mockInsertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({
          collectionId: 'col_001',
          sourceConceptId: 'concept_a',
          targetConceptId: 'concept_b',
          relationshipType: 'related'
        })
      )
    })

    it('buildRelationships 跳过不存在的相关概念', async () => {
      // 服务查询链为 select().from().where()（无 limit），where 直接返回数组
      const mockSelectChain = {
        from: mock().mockReturnThis(),
        where: mock().mockResolvedValue([])
      }
      db.select.mockReturnValue(mockSelectChain as any)

      const mockInsertChain = {
        values: mock().mockResolvedValue([])
      }
      db.insert.mockReturnValue(mockInsertChain as any)

      const concepts = [
        { id: 'concept_a', conceptName: '机器学习', relatedConcepts: [{ name: '不存在的概念', type: 'related' }] }
      ]

      await service.buildRelationships('col_001', concepts)

      expect(db.insert).not.toHaveBeenCalled()
    })
  })

  describe('runCompilation - 哈希增量编译', () => {
    it('内容哈希相同的文档应该被跳过，不调用 LLM', async () => {
      const docContent = '这是一段文档内容'
      const contentHash = createHash('sha256').update(docContent).digest('hex')

      const mockDoc = {
        id: 'doc_skip_001',
        knowledgeBaseId: 'kb_test_123',
        content: docContent,
        status: 'completed'
      }

      const mockExistingSource = {
        id: 'wiki_src_001',
        conceptId: 'wiki_concept_001',
        documentId: 'doc_skip_001',
        contentHash: contentHash
      }

      const mockUpdateChain = {
        set: mock().mockReturnThis(),
        where: mock().mockResolvedValue([])
      }
      db.update.mockReturnValue(mockUpdateChain as any)

      db.select        // 第1次：获取文档列表
        .mockReturnValueOnce({
          from: mock().mockReturnThis(),
          where: mock().mockResolvedValue([mockDoc])
        } as any)
        // 第2次：获取已有概念名称（用于提示词去重）
        .mockReturnValueOnce({
          from: mock().mockReturnThis(),
          where: mock().mockResolvedValue([])
        } as any)
        // 第3次：查询该文档的来源记录（判断哈希是否相同）
        .mockReturnValueOnce({
          from: mock().mockReturnThis(),
          where: mock().mockReturnThis(),
          limit: mock().mockResolvedValue([mockExistingSource])
        } as any)
        // 第4次：Phase 2 查询集合中所有概念（allConceptsInCollection）
        .mockReturnValueOnce({
          from: mock().mockReturnThis(),
          where: mock().mockResolvedValue([])
        } as any)

      await (service as any).runCompilation('wiki_task_test', mockCollection.id, 'kb_test_123')

      expect(generateText).not.toHaveBeenCalled()
    })
  })
})
