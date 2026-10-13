import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test'
import type { WikiCollection } from '../../types/wiki.types.js'

const mockSearchService = {
  searchConceptsScored: mock(),
  getRelatedConcepts: mock(),
  getConceptSources: mock().mockResolvedValue([])
}

const mockCollectionService = {
  getCollectionByKnowledgeBaseId: mock()
}

const mockNavigateService = {
  getOverview: mock()
}

mock.module('../../services/wiki-search.service.js', () => ({
  WikiSearchService: mock(() => mockSearchService)
}))

mock.module('../../services/wiki-collection.service.js', () => ({
  WikiCollectionService: mock(() => mockCollectionService)
}))

mock.module('../../services/wiki-navigate.service.js', () => ({
  WikiNavigateService: mock(() => mockNavigateService)
}))

mock.module('../../db/index.js', () => ({
  db: { select: mock() },
  wikiCollections: {},
  wikiConcepts: { id: 'id', collectionId: 'collection_id', conceptName: 'concept_name', slug: 'slug', definition: 'definition', summary: 'summary', content: 'content', tags: 'tags', occurrenceCount: 'occurrence_count', status: 'status', createdAt: 'created_at', updatedAt: 'updated_at' },
  wikiRelationships: {},
  wikiConceptSources: {},
  wikiCompileTasks: {},
  documents: { id: 'id', metadata: 'metadata' },
  pool: { connect: mock() },
  schemaName: 'test'
}))

mock.module('drizzle-orm', () => ({
  eq: mock((field: any, value: any) => ({ field, value, op: 'eq' })),
  and: mock((...conditions: any[]) => ({ conditions, op: 'and' })),
  sql: mock((template: any, ...params: any[]) => ({ template, params })),
  desc: mock(),
  inArray: mock()
}))

// bun test：mock.module 不提升，被测模块用 top-level await 动态 import
const { WikiRetrievalService } = await import('../../services/wiki-retrieval.service.js')

describe('WikiRetrievalService', () => {
  let service: any

  const now = new Date()

  const mockCollection: WikiCollection = {
    id: 'col_123',
    knowledgeBaseId: 'kb_123',
    name: 'Test',
    status: 'active',
    conceptCount: 3,
    createdAt: now,
    updatedAt: now
  }

  beforeEach(() => {
    mock.clearAllMocks()
    service = new WikiRetrievalService(mockSearchService as any, mockCollectionService as any, mockNavigateService as any)
  })

  describe('retrieve', () => {
    it('知识库没有集合时应返回空上下文', async () => {
      mockCollectionService.getCollectionByKnowledgeBaseId.mockResolvedValue(null)

      const result = await service.retrieve('kb_missing', 'test query')

      expect(result.citedPages).toEqual([])
      expect(result.totalEstimatedTokens).toBe(0)
    })

    it('应该返回带编号的上下文', async () => {
      mockCollectionService.getCollectionByKnowledgeBaseId.mockResolvedValue(mockCollection)

      const mockScored = [
        { concept: { id: 'c1', conceptName: 'ML', slug: 'ml', summary: 'Machine Learning', definition: 'AI subset', occurrenceCount: 5, content: null }, score: 10, titleMatch: true, phraseMatch: false },
        { concept: { id: 'c2', conceptName: 'DL', slug: 'dl', summary: 'Deep Learning', definition: 'Neural networks', occurrenceCount: 3, content: null }, score: 5, titleMatch: false, phraseMatch: true }
      ]
      mockSearchService.searchConceptsScored.mockResolvedValue(mockScored)
      mockSearchService.getRelatedConcepts.mockResolvedValue([])
      mockNavigateService.getOverview.mockResolvedValue({
        conceptCount: 3, relationshipCount: 2, tagDistribution: [], recentConcepts: [], topConcepts: [], relationshipTypeDistribution: []
      })

      const result = await service.retrieve('kb_123', 'machine learning', { budgetTokens: 8000 })

      expect(result.citedPages.length).toBeGreaterThan(0)
      expect(result.citedPages[0].citationIndex).toBe(1)
      expect(result.citedPages[0].conceptName).toBe('ML')
      expect(result.totalEstimatedTokens).toBeGreaterThan(0)
      expect(result.budgetAllocation.totalBudget).toBe(8000)
      expect(result.budgetAllocation.pagesBudget).toBe(6400)
      expect(result.budgetAllocation.indexBudget).toBe(1200)
      expect(result.budgetAllocation.systemBudget).toBe(400)
    })

    it('图谱扩展应该增加额外概念', async () => {
      mockCollectionService.getCollectionByKnowledgeBaseId.mockResolvedValue(mockCollection)

      const seedConcept = { concept: { id: 'c1', conceptName: 'ML', slug: 'ml', summary: 'Machine Learning', definition: 'AI', occurrenceCount: 5, content: null }, score: 10, titleMatch: true, phraseMatch: false }
      mockSearchService.searchConceptsScored.mockResolvedValue([seedConcept])

      const expanded = { id: 'c2', conceptName: 'DL', slug: 'dl', summary: 'Deep Learning', definition: 'Neural nets', occurrenceCount: 3, collectionId: 'col_123', status: 'compiled' as const, tags: [], createdAt: now, updatedAt: now }
      mockSearchService.getRelatedConcepts.mockResolvedValue([expanded])
      mockNavigateService.getOverview.mockResolvedValue({
        conceptCount: 3, relationshipCount: 2, tagDistribution: [], recentConcepts: [], topConcepts: [], relationshipTypeDistribution: []
      })

      const result = await service.retrieve('kb_123', 'ML', { budgetTokens: 8000 })

      expect(mockSearchService.getRelatedConcepts).toHaveBeenCalledWith('c1', expect.any(Number))
      const dlPage = result.citedPages.find((p: any) => p.conceptName === 'DL')
      expect(dlPage).toBeDefined()
    })

    it('预算控制应该限制返回的概念数量', async () => {
      mockCollectionService.getCollectionByKnowledgeBaseId.mockResolvedValue(mockCollection)

      const manyConcepts = Array.from({ length: 20 }, (_, i) => ({
        concept: {
          id: `c${i}`, conceptName: `Concept${i}`, slug: `concept-${i}`,
          summary: `Summary ${i} with some text that makes it longer to consume more tokens in budget`,
          definition: `Definition ${i} with enough text to consume tokens for budget testing purposes`,
          occurrenceCount: 20 - i,
          content: `This is the full content for concept ${i}. It has multiple sentences. Each one adds tokens. We need this to be long enough that budget control kicks in and limits the number of returned pages.`
        },
        score: 20 - i,
        titleMatch: i < 3,
        phraseMatch: false
      }))
      mockSearchService.searchConceptsScored.mockResolvedValue(manyConcepts)
      mockSearchService.getRelatedConcepts.mockResolvedValue([])
      mockNavigateService.getOverview.mockResolvedValue({
        conceptCount: 20, relationshipCount: 10, tagDistribution: [], recentConcepts: [], topConcepts: [], relationshipTypeDistribution: []
      })

      const result = await service.retrieve('kb_123', 'test', { budgetTokens: 300 })

      // 300 tokens budget, 60% pages = 180 tokens, should not fit all 20 concepts
      expect(result.citedPages.length).toBeLessThan(20)
    })

    it('默认预算应为 4000 tokens', async () => {
      mockCollectionService.getCollectionByKnowledgeBaseId.mockResolvedValue(null)

      const result = await service.retrieve('kb_missing', 'test')

      expect(result.budgetAllocation.totalBudget).toBe(4000)
    })

    it('sourceDocuments 在无源文档时应为空数组', async () => {
      mockCollectionService.getCollectionByKnowledgeBaseId.mockResolvedValue(mockCollection)

      const concept = {
        concept: {
          id: 'c1', conceptName: 'Test', slug: 'test', summary: 'Summary', definition: 'Def',
          occurrenceCount: 1, content: null
        },
        score: 10,
        titleMatch: true,
        phraseMatch: false
      }
      mockSearchService.searchConceptsScored.mockResolvedValue([concept])
      mockSearchService.getRelatedConcepts.mockResolvedValue([])
      mockNavigateService.getOverview.mockResolvedValue({
        conceptCount: 1, relationshipCount: 0, tagDistribution: [], recentConcepts: [], topConcepts: [], relationshipTypeDistribution: []
      })
      mockSearchService.getConceptSources.mockResolvedValue([])

      const result = await service.retrieve('kb_123', 'test', { budgetTokens: 8000 })

      expect(result.citedPages.length).toBeGreaterThan(0)
      expect(result.citedPages[0].sourceDocuments).toEqual([])
    })
  })
})
