import { describe, it, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test'
import type { WikiConcept, WikiCollection } from '../../types/wiki.types.js'

const mockSelect = mock()
const mockQuery = mock()
const mockRelease = mock()


mock.module('../../db/index.js', () => ({
  db: { select: () => mockSelect(), insert: mock() },
  wikiConcepts: {
    id: 'id', collectionId: 'collection_id', conceptName: 'concept_name',
    slug: 'slug', definition: 'definition', summary: 'summary',
    content: 'content', tags: 'tags', occurrenceCount: 'occurrence_count',
    status: 'status', createdAt: 'created_at', updatedAt: 'updated_at'
  },
  wikiConceptSources: {
    id: 'id', conceptId: 'concept_id', documentId: 'document_id',
    contentHash: 'content_hash', compiledAt: 'compiled_at'
  },
  wikiRelationships: {},
  wikiCompileTasks: {},
  wikiCollections: {},
  pool: { connect: mock().mockResolvedValue({ query: mockQuery, release: mockRelease }) },
  schemaName: 'test',
}))

mock.module('drizzle-orm', () => ({
  eq: mock((field: any, value: any) => ({ field, value, op: 'eq' })),
  and: mock((...conditions: any[]) => ({ conditions, op: 'and' })),
  or: mock((...conditions: any[]) => ({ conditions, op: 'or' })),
  ilike: mock((field: any, value: any) => ({ field, value, op: 'ilike' })),
  sql: mock((template: any, params?: any[]) => ({ template, params }))
}))

describe('WikiSearchService', () => {
  let service: any
  let mockCollectionService: any

  const now = new Date()

  const mockCollection: WikiCollection = {
    id: 'wiki_col_123',
    knowledgeBaseId: 'kb_123',
    name: '测试集合',
    status: 'active',
    conceptCount: 5,
    createdAt: now,
    updatedAt: now
  }

  const mockConcept: WikiConcept = {
    id: 'concept_1',
    collectionId: 'wiki_col_123',
    conceptName: '机器学习',
    slug: 'machine-learning',
    definition: '一种人工智能方法',
    summary: '使计算机能够从数据中学习',
    tags: ['AI', 'ML'],
    occurrenceCount: 3,
    status: 'compiled',
    createdAt: now,
    updatedAt: now
  }

  const mockConceptRow = {
    id: 'concept_1',
    collectionId: 'wiki_col_123',
    conceptName: '机器学习',
    slug: 'machine-learning',
    definition: '一种人工智能方法',
    summary: '使计算机能够从数据中学习',
    content: null,
    tags: ['AI', 'ML'],
    occurrenceCount: 3,
    status: 'compiled',
    createdAt: now,
    updatedAt: now
  }

  beforeEach(async () => {
    mock.clearAllMocks()
    mockCollectionService = {
      getCollectionByKnowledgeBaseId: mock()
    }
    const { WikiSearchService } = await import('../../services/wiki-search.service.js')
    service = new WikiSearchService(mockCollectionService)
  })

  describe('searchConcepts', () => {
    it('应该返回匹配的概念列表', async () => {
      mockCollectionService.getCollectionByKnowledgeBaseId.mockResolvedValue(mockCollection)

      const scoredRows = [{
        id: 'concept_1',
        concept_name: '机器学习',
        slug: 'machine-learning',
        definition: '一种人工智能方法',
        summary: '使计算机能够从数据中学习',
        content: null,
        tags: ['AI', 'ML'],
        occurrence_count: 3,
        status: 'compiled',
        created_at: now,
        updated_at: now,
        score: '0.5',
        title_match: true,
        phrase_match: false
      }]

      mockQuery
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ rows: scoredRows })

      const result = await service.searchConcepts('kb_123', '机器学习')

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('concept_1')
      expect(result[0].conceptName).toBe('机器学习')
      expect(result[0].slug).toBe('machine-learning')
      expect(result[0].tags).toEqual(['AI', 'ML'])
      expect(mockCollectionService.getCollectionByKnowledgeBaseId).toHaveBeenCalledWith('kb_123')
    })

    it('知识库没有 Wiki 集合时应该返回空数组', async () => {
      mockCollectionService.getCollectionByKnowledgeBaseId.mockResolvedValue(null)

      const result = await service.searchConcepts('kb_nonexistent', '测试')

      expect(result).toEqual([])
    })

    it('应该使用自定义 topK', async () => {
      mockCollectionService.getCollectionByKnowledgeBaseId.mockResolvedValue(mockCollection)

      mockQuery
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ rows: [] })

      await service.searchConcepts('kb_123', '测试', { topK: 5 })

      const sqlCall = mockQuery.mock.calls[1]
      const sqlText = sqlCall[0] as string
      expect(sqlText).toContain('5')
    })
  })

  describe('getRelatedConcepts', () => {
    it('深度 2 遍历应该返回关联概念', async () => {
      const relatedRow = {
        id: 'concept_2',
        collection_id: 'wiki_col_123',
        concept_name: '深度学习',
        slug: 'deep-learning',
        definition: '多层神经网络的学习方法',
        summary: '机器学习的子领域',
        content: null,
        tags: ['AI', 'DL'],
        occurrence_count: 2,
        status: 'compiled',
        created_at: now,
        updated_at: now
      }

      mockQuery
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ rows: [relatedRow] })

      const result = await service.getRelatedConcepts('concept_1', 2)

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('concept_2')
      expect(result[0].conceptName).toBe('深度学习')
      expect(result[0].collectionId).toBe('wiki_col_123')

      expect(mockRelease).toHaveBeenCalled()
    })

    it('环形关系不应导致无限循环（SQL 包含环检测）', async () => {
      mockQuery
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ rows: [] })

      await service.getRelatedConcepts('concept_1', 2)

      const sqlCall = mockQuery.mock.calls[1]
      const sqlText = sqlCall[0] as string
      expect(sqlText).toContain('WITH RECURSIVE')
      expect(sqlText).toContain('<> ALL(cg.path)')
      expect(sqlText).toContain('!= $1')
    })

    it('深度应该被限制在 3 以内', async () => {
      mockQuery
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ rows: [] })

      await service.getRelatedConcepts('concept_1', 10)

      const sqlCall = mockQuery.mock.calls[1]
      const params = sqlCall[1] as any[]
      expect(params[1]).toBe(3)
    })

    it('发生错误时应该释放 client', async () => {
      mockQuery.mockRejectedValueOnce(new Error('DB error'))

      await expect(service.getRelatedConcepts('concept_1')).rejects.toThrow('DB error')
      expect(mockRelease).toHaveBeenCalled()
    })
  })

  describe('getConceptBySlug', () => {
    it('精确匹配应该返回概念', async () => {
      const mockSelectChain = {
        from: mock().mockReturnThis(),
        where: mock().mockResolvedValue([mockConceptRow])
      }
      mockSelect.mockReturnValue(mockSelectChain)

      const result = await service.getConceptBySlug('wiki_col_123', 'machine-learning')

      expect(result).not.toBeNull()
      expect(result!.id).toBe('concept_1')
      expect(result!.slug).toBe('machine-learning')
      expect(result!.conceptName).toBe('机器学习')
    })

    it('找不到概念时应该返回 null', async () => {
      const mockSelectChain = {
        from: mock().mockReturnThis(),
        where: mock().mockResolvedValue([])
      }
      mockSelect.mockReturnValue(mockSelectChain)

      const result = await service.getConceptBySlug('wiki_col_123', 'nonexistent')

      expect(result).toBeNull()
    })
  })

  describe('getConceptSources', () => {
    it('应该返回来源文档 ID 列表', async () => {
      const mockSourceRows = [
        { id: 'src_1', conceptId: 'concept_1', documentId: 'doc_1', contentHash: 'abc', compiledAt: now },
        { id: 'src_2', conceptId: 'concept_1', documentId: 'doc_2', contentHash: 'def', compiledAt: now }
      ]

      const mockSelectChain = {
        from: mock().mockReturnThis(),
        where: mock().mockResolvedValue(mockSourceRows)
      }
      mockSelect.mockReturnValue(mockSelectChain)

      const result = await service.getConceptSources('concept_1')

      expect(result).toEqual(['doc_1', 'doc_2'])
    })

    it('没有来源时应该返回空数组', async () => {
      const mockSelectChain = {
        from: mock().mockReturnThis(),
        where: mock().mockResolvedValue([])
      }
      mockSelect.mockReturnValue(mockSelectChain)

      const result = await service.getConceptSources('concept_nonexistent')

      expect(result).toEqual([])
    })
  })

  describe('search', () => {
    it('聚合方法应该返回完整结果（概念 + 关联 + 来源）', async () => {
      const relatedConcept: WikiConcept = {
        id: 'concept_2',
        collectionId: 'wiki_col_123',
        conceptName: '深度学习',
        slug: 'deep-learning',
        definition: '多层神经网络',
        summary: '机器学习子领域',
        tags: ['DL'],
        occurrenceCount: 2,
        status: 'compiled',
        createdAt: now,
        updatedAt: now
      }

      spyOn(service, 'searchConcepts').mockResolvedValue([mockConcept])
      spyOn(service, 'getRelatedConcepts').mockResolvedValue([relatedConcept])
      spyOn(service, 'getConceptSources').mockResolvedValue(['doc_1', 'doc_2'])

      const result = await service.search('kb_123', '机器学习', {
        topK: 5,
        includeRelated: true,
        depth: 2
      })

      expect(result.results).toHaveLength(1)
      expect(result.total).toBe(1)
      expect(result.results[0].concept).toEqual(mockConcept)
      expect(result.results[0].relatedConcepts).toEqual([relatedConcept])
      expect(result.results[0].sourceDocumentIds).toEqual(['doc_1', 'doc_2'])

      expect(service.searchConcepts).toHaveBeenCalledWith('kb_123', '机器学习', { topK: 5 })
      expect(service.getRelatedConcepts).toHaveBeenCalledWith('concept_1', 2)
      expect(service.getConceptSources).toHaveBeenCalledWith('concept_1')
    })

    it('includeRelated 为 false 时不应获取关联概念', async () => {
      spyOn(service, 'searchConcepts').mockResolvedValue([mockConcept])
      spyOn(service, 'getRelatedConcepts').mockResolvedValue([])
      spyOn(service, 'getConceptSources').mockResolvedValue([])

      const result = await service.search('kb_123', '机器学习', { includeRelated: false })

      expect(result.results[0].relatedConcepts).toEqual([])
      expect(service.getRelatedConcepts).not.toHaveBeenCalled()
    })

    it('搜索无结果时应该返回空数组', async () => {
      spyOn(service, 'searchConcepts').mockResolvedValue([])

      const result = await service.search('kb_123', '不存在的概念')

      expect(result.results).toEqual([])
      expect(result.total).toBe(0)
    })
  })

  describe('tokenizeQuery', () => {
    it('英文查询应该按空格分词', async () => {
      const { tokenizeQuery } = await import('../../services/wiki-search.service.js')
      const tokens = tokenizeQuery('machine learning algorithm')
      expect(tokens).toContain('machine')
      expect(tokens).toContain('learning')
      expect(tokens).toContain('algorithm')
    })

    it('中文查询应该生成 bigram', async () => {
      const { tokenizeQuery } = await import('../../services/wiki-search.service.js')
      const tokens = tokenizeQuery('机器学习')
      expect(tokens.length).toBeGreaterThan(0)
    })

    it('中英混合查询应该正确处理', async () => {
      const { tokenizeQuery } = await import('../../services/wiki-search.service.js')
      const tokens = tokenizeQuery('机器学习 ML model')
      expect(tokens).toContain('ml')
      expect(tokens).toContain('model')
    })

    it('空查询应返回空数组', async () => {
      const { tokenizeQuery } = await import('../../services/wiki-search.service.js')
      expect(tokenizeQuery('')).toEqual([])
      expect(tokenizeQuery('   ')).toEqual([])
    })
  })

  describe('searchConceptsScored', () => {
    it('应该使用 tsvector 搜索并返回带分数的结果', async () => {
      mockCollectionService.getCollectionByKnowledgeBaseId.mockResolvedValue(mockCollection)

      const scoredRows = [{
        id: 'c1',
        concept_name: 'Machine Learning',
        slug: 'machine-learning',
        definition: 'AI subset',
        summary: 'Learn from data',
        content: null,
        tags: ['AI'],
        occurrence_count: 5,
        status: 'compiled',
        created_at: now,
        updated_at: now,
        score: '0.15',
        title_match: true,
        phrase_match: false
      }]

      mockQuery
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ rows: scoredRows })

      const result = await service.searchConceptsScored('kb_123', 'machine learning')

      expect(result).toHaveLength(1)
      expect(result[0].concept.conceptName).toBe('Machine Learning')
      expect(result[0].score).toBe(0.15)
      expect(result[0].titleMatch).toBe(true)
    })

    it('知识库没有集合时应该返回空数组', async () => {
      mockCollectionService.getCollectionByKnowledgeBaseId.mockResolvedValue(null)

      const result = await service.searchConceptsScored('kb_missing', 'test')

      expect(result).toEqual([])
    })
  })
})
