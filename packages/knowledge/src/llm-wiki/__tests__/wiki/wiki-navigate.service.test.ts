import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test'

const mockSelect = mock()
const mockQuery = mock()
const mockRelease = mock()


mock.module('../../db/index.js', () => ({
  db: { select: () => mockSelect() },
  wikiConcepts: {
    id: 'id', collectionId: 'collection_id', conceptName: 'concept_name',
    slug: 'slug', definition: 'definition', summary: 'summary',
    content: 'content', tags: 'tags', occurrenceCount: 'occurrence_count',
    status: 'status', createdAt: 'created_at', updatedAt: 'updated_at'
  },
  wikiRelationships: {
    id: 'id', collectionId: 'collection_id', sourceConceptId: 'source_concept_id',
    targetConceptId: 'target_concept_id', relationshipType: 'relationship_type',
    strength: 'strength', createdAt: 'created_at'
  },
  pool: { connect: mock().mockResolvedValue({ query: mockQuery, release: mockRelease }) },
  schemaName: 'test',
  wikiCollections: {},
  wikiConceptSources: {},
  wikiCompileTasks: {},
}))

mock.module('drizzle-orm', () => ({
  eq: mock((field: any, value: any) => ({ field, value, op: 'eq' })),
  and: mock((...conditions: any[]) => ({ conditions, op: 'and' })),
  or: mock((...conditions: any[]) => ({ conditions, op: 'or' })),
  desc: mock((field: any) => ({ field, dir: 'desc' })),
  sql: mock((template: any, ...params: any[]) => ({ template, params }))
}))

describe('WikiNavigateService', () => {
  let service: any

  beforeEach(async () => {
    mock.clearAllMocks()
    const { WikiNavigateService } = await import('../../services/wiki-navigate.service.js')
    service = new WikiNavigateService({} as any)
  })

  describe('getOverview', () => {
    it('应该返回完整的导航概览', async () => {
      const countChain = { from: mock().mockReturnThis(), where: mock().mockResolvedValue([{ count: 10 }]) }
      const tagChain = { from: mock().mockReturnThis(), where: mock().mockReturnThis(), groupBy: mock().mockReturnThis(), orderBy: mock().mockReturnThis(), limit: mock().mockResolvedValue([{ tag: 'AI', count: 5 }]) }
      const recentChain = { from: mock().mockReturnThis(), where: mock().mockReturnThis(), orderBy: mock().mockReturnThis(), limit: mock().mockResolvedValue([{ id: 'c1', conceptName: 'ML', updatedAt: new Date() }]) }
      const topChain = { from: mock().mockReturnThis(), where: mock().mockReturnThis(), orderBy: mock().mockReturnThis(), limit: mock().mockResolvedValue([{ id: 'c1', conceptName: 'ML', occurrenceCount: 5 }]) }
      const typeChain = { from: mock().mockReturnThis(), where: mock().mockReturnThis(), groupBy: mock().mockReturnThis(), orderBy: mock().mockResolvedValue([{ type: 'related', count: 8 }]) }

      mockSelect
        .mockReturnValueOnce(countChain)
        .mockReturnValueOnce(countChain)
        .mockReturnValueOnce(tagChain)
        .mockReturnValueOnce(recentChain)
        .mockReturnValueOnce(topChain)
        .mockReturnValueOnce(typeChain)

      const result = await service.getOverview('col_123')

      expect(result.conceptCount).toBe(10)
      expect(result.relationshipCount).toBe(10)
      expect(result.tagDistribution).toEqual([{ tag: 'AI', count: 5 }])
      expect(result.recentConcepts).toHaveLength(1)
      expect(result.topConcepts).toHaveLength(1)
      expect(result.relationshipTypeDistribution).toEqual([{ type: 'related', count: 8 }])
    })
  })

  describe('getConceptsByTag', () => {
    it('应该返回指定标签的概念', async () => {
      const mockChain = {
        from: mock().mockReturnThis(),
        where: mock().mockReturnThis(),
        orderBy: mock().mockResolvedValue([{ id: 'c1', conceptName: 'ML', slug: 'ml', summary: 'test', tags: ['AI'], occurrenceCount: 3 }])
      }
      mockSelect.mockReturnValue(mockChain)

      const result = await service.getConceptsByTag('col_123', 'AI')

      expect(result).toHaveLength(1)
      expect(result[0].conceptName).toBe('ML')
    })
  })

  describe('getConceptsByPage', () => {
    it('应该返回分页概念列表', async () => {
      const countChain = { from: mock().mockReturnThis(), where: mock().mockResolvedValue([{ count: 25 }]) }
      const pageChain = {
        from: mock().mockReturnThis(),
        where: mock().mockReturnThis(),
        orderBy: mock().mockReturnThis(),
        limit: mock().mockReturnThis(),
        offset: mock().mockResolvedValue([{ id: 'c1', conceptName: 'ML', slug: 'ml', summary: 'test', tags: ['AI'], occurrenceCount: 3, updatedAt: new Date() }])
      }
      mockSelect
        .mockReturnValueOnce(countChain)
        .mockReturnValueOnce(pageChain)

      const result = await service.getConceptsByPage('col_123', 2, 10)

      expect(result.page).toBe(2)
      expect(result.pageSize).toBe(10)
      expect(result.total).toBe(25)
      expect(result.concepts).toHaveLength(1)
    })
  })

  describe('getGraphStats', () => {
    it('应该返回图谱统计数据', async () => {
      mockQuery
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({
          rows: [{
            average_degree: 3.5,
            max_degree: 10,
            max_degree_concept_id: 'c1',
            max_degree_concept_name: '机器学习',
            max_degree_value: 10,
            isolated_count: 2,
            total_edges: 20
          }]
        })

      const result = await service.getGraphStats('col_123')

      expect(result.averageDegree).toBe(3.5)
      expect(result.maxDegree).toBe(10)
      expect(result.maxDegreeConcept.conceptName).toBe('机器学习')
      expect(result.isolatedConceptCount).toBe(2)
      expect(result.totalEdges).toBe(20)
      expect(mockRelease).toHaveBeenCalled()
    })

    it('发生错误时应该释放 client', async () => {
      mockQuery.mockRejectedValueOnce(new Error('DB error'))

      await expect(service.getGraphStats('col_123')).rejects.toThrow('DB error')
      expect(mockRelease).toHaveBeenCalled()
    })
  })
})
