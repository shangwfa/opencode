import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test'
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
  const mockPoolQuery = mock(async () => ({ rows: [], rowCount: 0 }))
  const mockClientQuery = mock(async () => ({ rows: [], rowCount: 0 }))
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
    revision: 'revision',
    citationStatus: 'citation_status',
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
    updatedAt: 'updated_at', documentId: 'document_id', workerId: 'worker_id', leaseExpiresAt: 'lease_expires_at',
    heartbeatAt: 'heartbeat_at', attempt: 'attempt'
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
    pool: {
      query: mockPoolQuery,
      connect: mock(async () => ({ query: mockClientQuery, release: mock() })),
    },
    __mockClientQuery: mockClientQuery,
    schemaName: 'test',
    documents: mockDocuments,
    wikiCollections: mockWikiCollections,
    wikiConcepts: mockWikiConcepts,
    wikiConceptSources: mockWikiConceptSources,
    wikiCompileTasks: mockWikiCompileTasks,
    wikiRelationships: mockWikiRelationships,
    wikiPageRevisions: {},
    wikiActivityLog: {},
    wikiSchemas: { id: 'id', collectionId: 'collection_id', version: 'version', config: 'config', createdAt: 'created_at' }
  }
})

mock.module('drizzle-orm', () => ({
  eq: mock((field: any, value: any) => ({ field, value, type: 'eq' })),
  and: mock((...conditions: any[]) => ({ conditions, type: 'and' })),
  inArray: mock((field: any, values: any[]) => ({ field, values, type: 'inArray' })),
  or: mock((...conditions: any[]) => ({ conditions, type: 'or' })),
  desc: mock((field: any) => ({ field, type: 'desc' })),
  sql: mock((template: any, ...params: any[]) => ({ template, params }))
}))

// bun test：mock.module 不提升，被测模块与被 mock 模块统一用 top-level await 动态 import
const { WikiCompilerService } = await import('../../services/wiki-compiler.service.js')
const dbMod: any = await import('../../db/index.js')
const db = dbMod.db
const mockPoolQuery: any = dbMod.pool.query
const mockClientQuery: any = dbMod.__mockClientQuery
// mock.module('ai') 后运行时是 mock 函数，断言用 any 规避真实类型
const generateText: any = (await import('ai')).generateText
const { buildSourceManifest } = await import('../../services/wiki-provenance.js')
const unitManifest = buildSourceManifest({ id: 'unit-doc', knowledgeBaseId: 'kb', type: 'markdown', content: '机器学习是一种 AI 技术。' })

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
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 })
    mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 })

    mockWikiCollectionService = {
      getOrCreateCollection: mock().mockResolvedValue(mockCollection),
      updateCollection: mock().mockResolvedValue(mockCollection)
    }

    mockKnowledgeBaseService = {}

    service = new WikiCompilerService(mockWikiCollectionService)
  })

  describe('recovery lifecycle', () => {
    it('logs rejected startup and interval scans without stopping later scans', async () => {
      const callbacks: Array<() => void> = []
      const timer = { unref: mock() }
      const interval = spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void) => {
        callbacks.push(callback)
        return timer
      }) as any)
      const clear = spyOn(globalThis, 'clearInterval').mockImplementation(() => {})
      const log = spyOn(console, 'error').mockImplementation(() => {})
      const failure = Object.assign(new Error('relation does not exist'), { code: '42P01' })
      service.recoverAvailableTasks = mock()
        .mockRejectedValueOnce(failure)
        .mockRejectedValueOnce(new Error('connection lost'))
        .mockResolvedValue(undefined)
      try {
        service.startRecovery()
        await Promise.resolve()
        expect(log).toHaveBeenCalledWith('[WikiCompiler] task recovery failed:', failure)
        service.startRecovery()
        expect(interval).toHaveBeenCalledTimes(1)
        callbacks[0]!()
        await Promise.resolve()
        expect(log).toHaveBeenCalledTimes(2)
        callbacks[0]!()
        await Promise.resolve()
        expect(service.recoverAvailableTasks).toHaveBeenCalledTimes(3)
        expect(log).toHaveBeenCalledTimes(2)
        expect(timer.unref).toHaveBeenCalledTimes(1)
        service.stopRecovery()
        expect(clear).toHaveBeenCalledWith(timer)
      } finally {
        service.stopRecovery()
        interval.mockRestore()
        clear.mockRestore()
        log.mockRestore()
      }
    })

    it('direct recovery retains its rejection contract for callers', async () => {
      mockPoolQuery.mockRejectedValueOnce(new Error('database unavailable'))
      await expect(service.recoverAvailableTasks()).rejects.toThrow('database unavailable')
    })
  })

  describe('compileKnowledgeBase', () => {
    it('应该成功创建编译任务并返回 taskId', async () => {
      // 此处只验证任务创建契约，后台编译由独立用例验证。
      service.runCompilation = mock().mockResolvedValue(undefined)

      const taskId = await service.compileKnowledgeBase('kb_test_123')

      expect(taskId).toMatch(/^wiki_task_/)
      expect(mockWikiCollectionService.getOrCreateCollection).toHaveBeenCalledWith('kb_test_123')
      expect(mockClientQuery.mock.calls.some(([query]: any[]) => String(query).includes('INSERT INTO test.wiki_compile_tasks'))).toBe(true)
    })

    it('当有正在运行的任务时应该抛出错误', async () => {
      mockClientQuery.mockImplementation(async (query: string) => String(query).includes('SELECT id FROM test.wiki_compile_tasks')
        ? { rows: [{ id: 'wiki_task_existing' }], rowCount: 1 } : { rows: [], rowCount: 0 })

      await expect(service.compileKnowledgeBase('kb_test_123')).rejects.toThrow(
        'already has a running compile task'
      )

      expect(mockClientQuery.mock.calls.some(([query]: any[]) => String(query).includes('INSERT INTO test.wiki_compile_tasks'))).toBe(false)
    })

    it('应该立即返回 taskId（不等待后台编译完成）', async () => {
      const startTime = Date.now()
      service.runCompilation = mock().mockResolvedValue(undefined)
      const taskId = await service.compileKnowledgeBase('kb_test_123')
      const elapsed = Date.now() - startTime

      expect(taskId).toBeDefined()
      expect(elapsed).toBeLessThan(500)
    })
  })

  describe('hasRunningTask', () => {
    it('当有正在运行的任务时应该返回 true', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 })

      const result = await service.hasRunningTask(mockCollection.id)

      expect(result).toBe(true)
    })

    it('当没有正在运行的任务时应该返回 false', async () => {
      const result = await service.hasRunningTask(mockCollection.id)

      expect(result).toBe(false)
    })

    it('数据库查询失败时应该抛出错误', async () => {
      mockPoolQuery.mockRejectedValueOnce(new Error('DB connection failed'))

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
    it('截断时记录失败原因与用量，最终返回 null', async () => {
      const truncated = { text: '{"concepts":[{"concept":"A"', finishReason: 'length', usage: { outputTokens: 2000, reasoningTokens: 1812 } }
      generateText.mockResolvedValueOnce(truncated as any)
      generateText.mockResolvedValueOnce({ ...truncated, usage: { outputTokens: 2000, reasoningTokens: 1790 } } as any)

      expect(await service.extractConceptsWithRetry('文档', [], 'doc_len')).toBeNull()

      expect(service.getExtractionFailure('doc_len')).toMatchObject({
        reason: 'truncated', finishReason: 'length', outputTokens: 2000, reasoningTokens: 1790, attempt: 2
      })
    })

    it('无 JSON 与结构不合法分别归类', async () => {
      generateText.mockResolvedValueOnce({ text: '没有任何结构化输出', finishReason: 'stop' } as any)
      generateText.mockResolvedValueOnce({ text: '没有任何结构化输出', finishReason: 'stop' } as any)
      await service.extractConceptsWithRetry('文档', [], 'doc_nojson')
      expect(service.getExtractionFailure('doc_nojson')?.reason).toBe('no_json')

      generateText.mockResolvedValueOnce({ text: '{"x":1}', finishReason: 'stop' } as any)
      generateText.mockResolvedValueOnce({ text: '{"x":1}', finishReason: 'stop' } as any)
      await service.extractConceptsWithRetry('文档', [], 'doc_schema')
      expect(service.getExtractionFailure('doc_schema')?.reason).toBe('invalid_output')
    })

    it('重试成功后清除该文档此前的失败记录', async () => {
      generateText.mockResolvedValueOnce({ text: '没有结构', finishReason: 'stop' } as any)
      generateText.mockResolvedValueOnce({ text: JSON.stringify({ concepts: [] }), finishReason: 'stop' } as any)

      expect(await service.extractConceptsWithRetry('文档', [], 'doc_ok')).toEqual([])
      expect(service.getExtractionFailure('doc_ok')).toBeUndefined()
    })

    it('输出预算必须覆盖推理模型的推理 token（实测 1812 推理 token 时 2000 预算被截断）', async () => {
      generateText.mockResolvedValueOnce({ text: JSON.stringify({ concepts: [] }) } as any)

      await (service as any).extractConceptsWithRetry('文档内容', [], 'doc_budget')

      const options = generateText.mock.calls.at(-1)[0]
      expect(options.maxOutputTokens).toBeGreaterThanOrEqual(4000)
    })

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

    it('两次 LLM 调用都失败时应该返回 null（限流错误除外，限流会透传中断批次）', async () => {
      // 注意：不能使用含 "rate limit"/"速率限制" 的文案，那类错误会透传中断批次（见限流识别用例）。
      generateText.mockRejectedValue(new Error('API server overloaded'))

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

    it('合法空概念列表应直接返回，不执行额外重试', async () => {
      generateText.mockResolvedValue({ text: '{"concepts":[]}' })
      expect(await service.extractConceptsWithRetry('文档', [], 'doc-empty')).toEqual([])
      expect(generateText).toHaveBeenCalledTimes(1)
    })

    it('两次返回无效 JSON 时应返回 null，不撤销已有概念', async () => {
      generateText.mockResolvedValue({ text: 'invalid' })
      expect(await service.extractConceptsWithRetry('文档', [], 'doc-invalid')).toBeNull()
      expect(generateText).toHaveBeenCalledTimes(2)
    })
  })

  describe('Phase 2 - 页面生成', () => {
    it('页面输出预算必须覆盖推理 token 与带引文的长页面（实测 3000 预算下草稿被截断为无效）', async () => {
      generateText.mockResolvedValueOnce({ text: JSON.stringify({ sections: [] }) } as any)

      await (service as any).generatePageDraft('机器学习', [unitManifest], [])

      const options = generateText.mock.calls.at(-1)[0]
      expect(options.maxOutputTokens).toBeGreaterThanOrEqual(12000)
    })

    it('草稿解析失败时记录 finishReason 与用量，不再是无声 null', async () => {
      generateText.mockResolvedValueOnce({ text: '{"sections":[{"heading":"a","content":"b', finishReason: 'length', usage: { outputTokens: 3000, reasoningTokens: 2400 } } as any)

      const draft = await (service as any).generatePageDraft('机器学习', [unitManifest], [])

      expect(draft).toBeNull()
      expect(service.getPageFailure('机器学习')).toMatchObject({
        reason: 'truncated', finishReason: 'length', outputTokens: 3000, reasoningTokens: 2400
      })
    })
    it('页面先生成草稿，成功时也不提前写数据库', async () => {
      const validPageResponse = JSON.stringify({
        sections: [{ heading: '概述', content: '机器学习是一种 AI 技术。', sourceRefs: [unitManifest.blocks[0].refId],
          claims: [{ statement: '机器学习是一种 AI 技术。', evidence: [{ refId: unitManifest.blocks[0].refId, quote: '机器学习是一种 AI 技术。' }] }] }],
        relatedConcepts: []
      })

      generateText.mockResolvedValueOnce({ text: validPageResponse } as any)

      const mockUpdateChain = {
        set: mock().mockReturnThis(),
        where: mock().mockReturnValue({ returning: mock().mockResolvedValue([{ id: 'wiki_task_test' }]) })
      }
      db.update.mockReturnValue(mockUpdateChain as any)

      const result = await service.generatePageDraft(
        '机器学习',
        [unitManifest],
        [],
        { sections: [{ heading: '旧页', content: '旧知识' }] },
      )

      expect(result.sections[0].content).toBe('机器学习是一种 AI 技术。')
      expect(generateText).toHaveBeenCalledTimes(1)
      expect(generateText.mock.calls[0][0].system).toContain('旧知识')
      expect(db.update).not.toHaveBeenCalled()
    })

    it('页面生成失败不提前发布内容或来源哈希', async () => {
      generateText.mockResolvedValueOnce({ text: '这不是有效的 JSON 格式' } as any)

      const result = await service.generatePageDraft(
        '深度学习',
        [unitManifest],
        []
      )

      expect(result).toBeNull()
      expect(db.update).not.toHaveBeenCalled()
      expect(db.insert).not.toHaveBeenCalled()
    })

    it('来源过长时拒绝静默截断', async () => {
      const result = await service.generatePageDraft('长概念', [buildSourceManifest({ id: 'long', knowledgeBaseId: 'kb', content: '甲'.repeat(30001) })])
      expect(result).toBeNull()
      expect(generateText).not.toHaveBeenCalled()
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
        where: mock().mockReturnValue({ returning: mock().mockResolvedValue([{ id: 'wiki_task_test' }]) })
      }
      db.update.mockReturnValue(mockUpdateChain as any)

      db.select
        // 第0次：用户可编辑 schema 读取（未配置 → 默认）
        .mockReturnValueOnce({
          from: mock().mockReturnThis(),
          where: mock().mockReturnValue({
            orderBy: mock().mockReturnValue({ limit: mock().mockResolvedValue([]) })
          })
        } as any)
        // 第1次：获取文档列表
        .mockReturnValueOnce({
          from: mock().mockReturnThis(),
          where: mock().mockResolvedValue([mockDoc])
        } as any)
        // 第2次：获取已有概念名称（用于提示词去重）
        .mockReturnValueOnce({
          from: mock().mockReturnThis(),
          where: mock().mockResolvedValue([{ id: 'wiki_concept_001', conceptName: '知识库', slug: '知识库', status: 'compiled', citationStatus: 'verified', revision: 1, updatedAt: new Date() }])
        } as any)
        // 第3次：查询本集合的全部来源（判断哈希是否相同）
        .mockReturnValueOnce({
          from: mock().mockReturnThis(),
          where: mock().mockResolvedValue([mockExistingSource])
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

  describe('限流识别与并发递减', () => {
    it('识别中文速率限制、429 与 1302 错误码，且穿透 cause 与 errors 链', async () => {
      const { isRateLimitError } = await import('../../services/wiki-compiler.service.js')
      expect(isRateLimitError(new Error('Failed after 3 attempts. Last error: 您的账户已达到速率限制，请您控制请求频率'))).toBe(true)
      expect(isRateLimitError(Object.assign(new Error('Too many requests'), { statusCode: 429 }))).toBe(true)
      expect(isRateLimitError(Object.assign(new Error('provider error'), { data: { error: { code: '1302', message: '限流' } } }))).toBe(true)
      expect(isRateLimitError({ message: 'outer', cause: new Error('rate limit exceeded') })).toBe(true)
      expect(isRateLimitError({ message: 'retry', errors: [new Error('x'), Object.assign(new Error('y'), { statusCode: 429 })] })).toBe(true)
      expect(isRateLimitError(new Error('受控提取失败'))).toBe(false)
      expect(isRateLimitError(Object.assign(new Error('Invalid JSON'), { data: { error: { code: '400' } } }))).toBe(false)
      expect(isRateLimitError(null)).toBe(false)
    })

    it('并发恒定：限流已由快速失败与任务中断保护，不再按 attempt 递减（曾致重试越跑越慢）', async () => {
      const { resolveConcurrency, WikiCompilerService } = await import('../../services/wiki-compiler.service.js')
      expect(resolveConcurrency(8, 1)).toBe(8)
      expect(resolveConcurrency(8, 2)).toBe(8)
      expect(resolveConcurrency(8, 5)).toBe(8)
      expect(resolveConcurrency(2, 3)).toBe(2)
      expect(WikiCompilerService.DEFAULT_PAGE_CONCURRENCY).toBe(2)
    })

    it('部分发布阈值：小批量不容忍失败；规模后容忍 ≤5%', async () => {
      const { allowPartialPublish } = await import('../../services/wiki-compiler.service.js')
      expect(allowPartialPublish(2, 1)).toBe(false)     // 小批量：1/2 失败整批拒绝（WM04 语义）
      expect(allowPartialPublish(10, 1)).toBe(false)    // 10 页容忍度 0（floor(0.5)=0）
      expect(allowPartialPublish(176, 3)).toBe(true)    // 1.7% 顽固页部分发布
      expect(allowPartialPublish(200, 10)).toBe(true)   // 恰好 5%
      expect(allowPartialPublish(176, 9)).toBe(false)   // 超阈值整批拒绝
    })
  })

  describe('durable task 领取与重试上限', () => {
    it('领取 SQL 必须带 attempt 上限条件，领取成功后执行编译', async () => {
      service.runCompilation = mock().mockResolvedValue(undefined)
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 'wiki_task_durable', collection_id: 'col', knowledge_base_id: 'kb', document_id: 'doc_a' }], rowCount: 1 })

      await (service as any).claimTask('wiki_task_durable')

      const claimSql = mockPoolQuery.mock.calls.map((call: any[]) => String(call[0])).find((sql: string) => sql.includes('worker_id=$2'))
      expect(claimSql).toContain('attempt < $4')
      expect(claimSql).toContain('lease_expires_at < NOW()')
      expect(service.runCompilation).toHaveBeenCalledWith('wiki_task_durable', 'col', 'kb', 'doc_a', expect.stringContaining('wiki-worker'), expect.any(Number))
    })

    it('恢复扫描先把超限过期任务标 failed，再领取剩余任务', async () => {
      await service.recoverAvailableTasks()

      const markFailedSql = String(mockPoolQuery.mock.calls[0][0])
      expect(markFailedSql).toContain("status='failed'")
      expect(markFailedSql).toContain('attempt >= $1')
      expect(markFailedSql).toContain('lease_expires_at < NOW()')
      const scanSql = String(mockPoolQuery.mock.calls[1][0])
      expect(scanSql).toContain('SELECT id')
    })

    it('getCompileTask 透传 documentId 与 attempt', async () => {
      const mockTask = {
        id: 'wiki_task_doc',
        collectionId: mockCollection.id,
        knowledgeBaseId: 'kb_test_123',
        status: 'running',
        progress: { total: 1, processed: 0, skipped: 0, failed: 0, extracted: 0 },
        documentId: 'doc_a',
        attempt: 2,
        createdAt: new Date(),
        updatedAt: new Date()
      }
      db.select.mockReturnValue({
        from: mock().mockReturnThis(),
        where: mock().mockResolvedValue([mockTask])
      } as any)

      const result = await service.getCompileTask('wiki_task_doc')

      expect(result?.documentId).toBe('doc_a')
      expect(result?.attempt).toBe(2)
    })
  })

  describe('失败任务重试', () => {
    it('只重排失败且未超限、同集合无其它活跃任务的任务；人工重试重置 attempt（防毒丸上限仅约束自动恢复）', async () => {
      service.claimTask = mock().mockResolvedValue(undefined)
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ collection_id: 'col' }], rowCount: 1 })

      expect(await service.retryCompileTask('wiki_task_failed')).toBe(true)

      const sql = String(mockPoolQuery.mock.calls[0][0])
      expect(sql).toContain("status='failed'")
      expect(sql).toContain("status='pending'")
      expect(sql).toContain('attempt=0')
      expect(sql).toContain("t2.status IN ('pending','running')")
      expect(service.claimTask).toHaveBeenCalledWith('wiki_task_failed')
    })

    it('不是失败任务时返回 false 且不领取', async () => {
      service.claimTask = mock().mockResolvedValue(undefined)
      expect(await service.retryCompileTask('wiki_task_running')).toBe(false)
      expect(service.claimTask).not.toHaveBeenCalled()
    })
  })
})
