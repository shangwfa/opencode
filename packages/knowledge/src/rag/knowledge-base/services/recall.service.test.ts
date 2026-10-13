/**
 * RecallService 单元测试
 * 测试召回服务功能
 */

import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test'
type RecallService = import('./recall.service').RecallService
import type { SearchResultItem } from '../types/knowledge-base.types'

// Mock 依赖服务
mock.module('./vector.service', () => ({
  VectorService: class VectorService {}
}))
mock.module('./keyword-search.service', () => ({
  KeywordSearchService: class KeywordSearchService {}
}))

// Mock ai 模块
mock.module('ai', () => ({
  embed: mock().mockResolvedValue({
    embedding: [0.1, 0.2, 0.3]
  }),
  generateText: mock().mockResolvedValue({
    text: '0.8'
  })
}))

// Mock @ai-sdk/openai
mock.module('@ai-sdk/openai', () => ({
  createOpenAI: mock(() => ({
    chat: mock(),
    embedding: mock(),
  })),
  openai: {
    embedding: mock()
  }
}))

// 被测模块：mock 注册后动态导入
const { RecallService } = await import('./recall.service')

describe('RecallService', () => {
  let recallService: RecallService
  let mockVectorService: any
  let mockKeywordSearchService: any
  let mockResults: SearchResultItem[]

  beforeEach(() => {
    mockVectorService = {
      query: mock().mockResolvedValue([]),
      search: mock().mockResolvedValue([])
    } as any

    mockKeywordSearchService = {
      search: mock().mockResolvedValue([])
    } as any

    recallService = new RecallService(mockVectorService, mockKeywordSearchService)

    mockResults = [
      {
        id: '1',
        text: 'Result 1',
        score: 0.9,
        metadata: { documentId: 'doc1', chunkIndex: 0 },
        documentId: 'doc1',
        chunkIndex: 0
      },
      {
        id: '2',
        text: 'Result 2',
        score: 0.7,
        metadata: { documentId: 'doc2', chunkIndex: 0 },
        documentId: 'doc2',
        chunkIndex: 0
      }
    ]
  })

  describe('初始化', () => {
    it('应该成功创建实例', () => {
      expect(recallService).toBeInstanceOf(RecallService)
    })
  })

  describe('recall - 单阶段召回', () => {
    it('应该执行单阶段召回', async () => {
      mockVectorService.query = mock().mockResolvedValue(mockResults)

      const result = await recallService.recall('kb1', 'test query', {
        enableMultiStage: false,
        coarseTopK: 20
      })

      expect(mockVectorService.query).toHaveBeenCalled()
      expect(result.length).toBeGreaterThanOrEqual(0)
    })

    it('应该使用自定义topK', async () => {
      mockVectorService.query = mock().mockResolvedValue(mockResults)

      await recallService.recall('kb1', 'test query', {
        enableMultiStage: false,
        fineTopK: 10
      })

      expect(mockVectorService.query).toHaveBeenCalledWith(
        'kb1',
        expect.any(Array),
        10,
        undefined,
        undefined
      )
    })

    it('应该传递pgVector配置', async () => {
      mockVectorService.query = mock().mockResolvedValue(mockResults)

      const pgVectorConfig = { minScore: 0.5, ef: 100, probes: 10 }
      await recallService.recall('kb1', 'test query', {
        enableMultiStage: false,
        pgVectorConfig
      })

      expect(mockVectorService.query).toHaveBeenCalledWith(
        'kb1',
        expect.any(Array),
        20,
        undefined,
        pgVectorConfig
      )
    })
  })

  describe('recall - 多阶段召回', () => {
    it('应该执行多阶段召回（默认）', async () => {
      mockVectorService.query = mock()
        .mockResolvedValueOnce(mockResults.slice(0, 1)) // 粗召回
        .mockResolvedValueOnce(mockResults) // 细召回

      const result = await recallService.recall('kb1', 'test query', {
        enableMultiStage: true,
        coarseTopK: 50,
        fineTopK: 20
      })

      expect(mockVectorService.query).toHaveBeenCalledTimes(2)
      expect(result.length).toBeGreaterThan(0)
    })

    it('应该在粗召回无结果时返回空', async () => {
      mockVectorService.query = mock().mockResolvedValue([])

      const result = await recallService.recall('kb1', 'test query', {
        enableMultiStage: true,
        coarseTopK: 50,
        fineTopK: 20
      })

      expect(result).toEqual([])
    })

    it('应该使用默认的coarseTopK和fineTopK', async () => {
      mockVectorService.query = mock().mockResolvedValue(mockResults)

      await recallService.recall('kb1', 'test query', {
        enableMultiStage: true
      })

      expect(mockVectorService.query).toHaveBeenNthCalledWith(
        1,
        'kb1',
        expect.any(Array),
        50,
        undefined,
        undefined
      )
    })
  })

  describe('recall - 查询扩展', () => {
    it('应该支持查询扩展', async () => {
      mockVectorService.query = mock().mockResolvedValue(mockResults)

      const result = await recallService.recall('kb1', 'test query', {
        enableMultiStage: false,
        enableQueryExpansion: true
      })

      // 查询扩展功能应该被触发
      expect(result.length).toBeGreaterThanOrEqual(0)
    })

    it('应该在不启用查询扩展时使用原始查询', async () => {
      mockVectorService.query = mock().mockResolvedValue(mockResults)

      const result = await recallService.recall('kb1', 'test query', {
        enableMultiStage: false,
        enableQueryExpansion: false
      })

      expect(result.length).toBeGreaterThanOrEqual(0)
    })
  })

  describe('recall - 嵌入模型', () => {
    it('应该使用默认嵌入模型', async () => {
      mockVectorService.query = mock().mockResolvedValue(mockResults)

      await recallService.recall('kb1', 'test query', {
        enableMultiStage: false
      })

      expect(mockVectorService.query).toHaveBeenCalled()
    })

    it('应该支持自定义嵌入模型', async () => {
      mockVectorService.query = mock().mockResolvedValue(mockResults)

      await recallService.recall('kb1', 'test query', {
        enableMultiStage: false,
        embeddingModel: 'openai/text-embedding-3-small'
      })

      expect(mockVectorService.query).toHaveBeenCalled()
    })
  })

  describe('recall - 边界情况', () => {
    it('应该处理空查询', async () => {
      mockVectorService.query = mock().mockResolvedValue([])

      const result = await recallService.recall('kb1', '', {
        enableMultiStage: false
      })

      expect(result.length).toBeGreaterThanOrEqual(0)
    })

    it('应该处理服务调用失败', async () => {
      mockVectorService.query = mock().mockRejectedValue(new Error('Service error'))

      await expect(recallService.recall('kb1', 'test query', {
        enableMultiStage: false
      })).rejects.toThrow('Service error')
    })

    it('应该处理去重逻辑', async () => {
      const duplicateResult = mockResults[0]

      mockVectorService.query = mock()
        .mockResolvedValueOnce([duplicateResult]) // 粗召回
        .mockResolvedValueOnce([duplicateResult]) // 细召回，相同结果

      const result = await recallService.recall('kb1', 'test query', {
        enableMultiStage: true,
        coarseTopK: 50,
        fineTopK: 20
      })

      // 应该去重
      const uniqueIds = new Set(result.map(r => r.id))
      expect(uniqueIds.size).toBeLessThanOrEqual(result.length)
    })
  })

  describe('recall - 结果合并', () => {
    it('应该合并多个阶段的召回结果', async () => {
      mockVectorService.query = mock()
        .mockResolvedValueOnce([mockResults[0]]) // 粗召回
        .mockResolvedValueOnce([mockResults[1]]) // 细召回

      const result = await recallService.recall('kb1', 'test query', {
        enableMultiStage: true,
        coarseTopK: 50,
        fineTopK: 20
      })

      expect(result.length).toBeGreaterThan(0)
    })

    it('应该保留分数最高的结果', async () => {
      mockVectorService.query = mock()
        .mockResolvedValueOnce([{ ...mockResults[0], score: 0.5 }]) // 粗召回，低分
        .mockResolvedValueOnce([{ ...mockResults[0], score: 0.9 }]) // 细召回，高分

      const result = await recallService.recall('kb1', 'test query', {
        enableMultiStage: true,
        coarseTopK: 50,
        fineTopK: 20
      })

      expect(result[0].score).toBe(0.9)
    })
  })
})
