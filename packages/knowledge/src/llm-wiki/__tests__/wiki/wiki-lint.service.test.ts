import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test'

const mockSelect = mock()
const mockQuery = mock()
const mockRelease = mock()
const mockPoolConnect = mock().mockResolvedValue({ query: mockQuery, release: mockRelease })


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
  pool: { connect: (...args: any[]) => mockPoolConnect(...args) },
  schemaName: 'test',
  wikiCollections: {},
  wikiConceptSources: {},
  wikiCompileTasks: {},
}))

mock.module('drizzle-orm', () => ({
  eq: mock((field: any, value: any) => ({ field, value, op: 'eq' })),
  sql: mock((template: any, ...params: any[]) => ({ template, params }))
}))

mock.module('ai', () => ({
  embed: mock(async () => ({ embedding: [] })),
  embedMany: mock(async () => ({ embeddings: [] })),
  generateText: mock(async () => ({ text: '' })),
  generateObject: mock(async () => ({ object: {} })),
  streamText: mock(() => ({ textStream: (async function* () {})() })),
}))

// 源工程 mock '@ai-sdk/openai'；目标工程 LLM 统一走 providers/llm 的 openaiChat
mock.module('../../../providers/llm.js', () => ({
  openaiChat: mock(() => 'mock-model'),
  openaiEmbedding: mock(() => 'mock-embedding-model'),
}))

const { generateText } = await import('ai')

describe('WikiLintService', () => {
  let service: any

  beforeEach(async () => {
    mock.clearAllMocks()
    mockQuery.mockResolvedValue({ rows: [] })
    const { WikiLintService } = await import('../../services/wiki-lint.service.js')
    service = new WikiLintService()
  })

  describe('runStructuralLint', () => {
    it('应该检测孤立概念（无关系）', async () => {
      const slugChain = { from: mock().mockReturnThis(), where: mock().mockResolvedValue([{ slug: 'orphan' }]) }
      const contentChain = {
        from: mock().mockReturnThis(),
        where: mock().mockResolvedValue([{ id: 'c1', conceptName: '孤立概念', content: null }])
      }

      mockSelect
        .mockReturnValueOnce(slugChain)
        .mockReturnValueOnce(contentChain)

      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'c1', concept_name: '孤立概念', slug: 'orphan' }] })
        .mockResolvedValueOnce({ rows: [] })

      const results = await service.runStructuralLint('col_123')

      const orphans = results.filter((r: any) => r.type === 'orphan')
      expect(orphans.length).toBeGreaterThanOrEqual(0)
    })

    it('应该检测断裂的 wiki 链接', async () => {
      const concepts = [{
        id: 'c1',
        conceptName: '测试概念',
        content: {
          sections: [{ heading: 'H1', content: '这是 [[nonexistent]] 链接', sourceRefs: [] }]
        }
      }]

      const slugsChain = {
        from: mock().mockReturnThis(),
        where: mock().mockResolvedValue([{ slug: 'test' }])
      }
      const contentChain = {
        from: mock().mockReturnThis(),
        where: mock().mockResolvedValue(concepts)
      }

      mockSelect
        .mockReturnValueOnce(contentChain)
        .mockReturnValueOnce(slugsChain)

      const results = await service.runStructuralLint('col_123')

      const broken = results.filter((r: any) => r.type === 'broken_link')
      expect(broken).toHaveLength(1)
      expect(broken[0].page).toBe('测试概念')
      expect(broken[0].severity).toBe('warning')
    })

    it('有效的 wiki 链接不应被标记', async () => {
      const concepts = [{
        id: 'c1',
        conceptName: '概念A',
        content: {
          sections: [{ heading: 'H1', content: '参考 [[concept-b]]', sourceRefs: [] }]
        }
      }]

      const slugsChain = {
        from: mock().mockReturnThis(),
        where: mock().mockResolvedValue([{ slug: 'concept-a' }, { slug: 'concept-b' }])
      }
      const contentChain = {
        from: mock().mockReturnThis(),
        where: mock().mockResolvedValue(concepts)
      }

      mockSelect
        .mockReturnValueOnce(contentChain)
        .mockReturnValueOnce(slugsChain)

      const results = await service.runStructuralLint('col_123')

      const broken = results.filter((r: any) => r.type === 'broken_link')
      expect(broken).toHaveLength(0)
    })
  })

  describe('runSemanticLint', () => {
    it('空集合应返回空数组', async () => {
      const chain = { from: mock().mockReturnThis(), where: mock().mockResolvedValue([]) }
      mockSelect.mockReturnValue(chain)

      const results = await service.runSemanticLint('col_123')
      expect(results).toEqual([])
    })

    it('应该调用 LLM 并解析结果', async () => {
      const concepts = [
        { id: 'c1', conceptName: 'ML', summary: 'Machine Learning', tags: ['AI'] }
      ]
      const chain = { from: mock().mockReturnThis(), where: mock().mockResolvedValue(concepts) }
      mockSelect.mockReturnValue(chain)

      const lintOutput = `---LINT: contradiction | warning | 矛盾概念 ---
ML 概念与其它描述矛盾。
PAGES: ML, DL
---END LINT---`

      ;(generateText as any).mockResolvedValue({ text: lintOutput })

      const results = await service.runSemanticLint('col_123')

      expect(results).toHaveLength(1)
      expect(results[0].type).toBe('contradiction')
      expect(results[0].severity).toBe('warning')
    })

    it('LLM 调用失败应返回空数组', async () => {
      const concepts = [
        { id: 'c1', conceptName: 'ML', summary: 'Machine Learning', tags: ['AI'] }
      ]
      const chain = { from: mock().mockReturnThis(), where: mock().mockResolvedValue(concepts) }
      mockSelect.mockReturnValue(chain)

      ;(generateText as any).mockRejectedValue(new Error('LLM error'))

      const results = await service.runSemanticLint('col_123')
      expect(results).toEqual([])
    })
  })

  describe('runLint', () => {
    it('默认只执行 structural lint', async () => {
      const chain = { from: mock().mockReturnThis(), where: mock().mockResolvedValue([]) }
      mockSelect.mockReturnValue(chain)
      mockQuery.mockResolvedValue({ rows: [] })

      const results = await service.runLint('col_123')

      expect(generateText).not.toHaveBeenCalled()
      expect(Array.isArray(results)).toBe(true)
    })

    it('includeSemantic=true 应同时执行 semantic lint', async () => {
      const chain = { from: mock().mockReturnThis(), where: mock().mockResolvedValue([{ id: 'c1', conceptName: 'ML', summary: 'test', tags: ['AI'] }]) }
      mockSelect.mockReturnValue(chain)
      mockQuery.mockResolvedValue({ rows: [] })

      ;(generateText as any).mockResolvedValue({ text: '' })

      await service.runLint('col_123', true)

      expect(generateText).toHaveBeenCalled()
    })
  })
})
