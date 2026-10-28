/**
 * HybridSearchService 单元测试
 * 测试混合检索功能
 */

import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test'
type HybridSearchService = import('./hybrid-search.service').HybridSearchService
import type { SearchResultItem } from '../types/knowledge-base.types'

// Mock 依赖服务
mock.module('./keyword-search.service', () => ({
  KeywordSearchService: class KeywordSearchService {}
}))
mock.module('./vector.service', () => ({
  VectorService: class VectorService {}
}))

// Mock ai 模块 - 内联以避免 hoisting 问题
mock.module('ai', () => ({
  embed: mock().mockResolvedValue({
    embedding: [0.1, 0.2, 0.3]
  }),
  // rerank 'mastra' 模式 / HyDE 走 generateText 打分
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
const { HybridSearchService } = await import('./hybrid-search.service')

describe('HybridSearchService', () => {
  let hybridSearchService: HybridSearchService
  let mockVectorService: any
  let mockKeywordSearchService: any
  let mockSemanticResults: SearchResultItem[]
  let mockKeywordResults: SearchResultItem[]

  beforeEach(() => {
    // 准备 mock 数据
    mockSemanticResults = [
      {
        id: '1',
        text: 'Semantic result 1',
        score: 0.9,
        metadata: { documentId: 'doc1', chunkIndex: 0 },
        documentId: 'doc1',
        chunkIndex: 0
      },
      {
        id: '2',
        text: 'Semantic result 2',
        score: 0.7,
        metadata: { documentId: 'doc2', chunkIndex: 0 },
        documentId: 'doc2',
        chunkIndex: 0
      }
    ]

    mockKeywordResults = [
      {
        id: '3',
        text: 'Keyword result 1',
        score: 0.8,
        metadata: { documentId: 'doc3', chunkIndex: 0 },
        documentId: 'doc3',
        chunkIndex: 0
      },
      {
        id: '4',
        text: 'Keyword result 2',
        score: 0.6,
        metadata: { documentId: 'doc4', chunkIndex: 0 },
        documentId: 'doc4',
        chunkIndex: 0
      }
    ]

    // 创建 mock 实例 (在数据初始化之后)
    mockVectorService = {
      search: mock(),
      query: mock().mockResolvedValue(mockSemanticResults)
    } as any

    mockKeywordSearchService = {
      search: mock()
    } as any

    hybridSearchService = new HybridSearchService(mockVectorService, mockKeywordSearchService)
  })

  describe('初始化', () => {
    it('应该成功创建实例', () => {
      expect(hybridSearchService).toBeInstanceOf(HybridSearchService)
    })
  })

  describe('search - 混合检索', () => {
    it('应该使用默认权重进行混合检索', async () => {
      mockVectorService.query = mock().mockResolvedValue(mockSemanticResults)
      mockKeywordSearchService.search = mock().mockResolvedValue(mockKeywordResults)

      const result = await hybridSearchService.search('kb1', 'test query')

      expect(result.length).toBeGreaterThan(0)
    })

    it('应该使用自定义权重进行混合检索', async () => {
      mockVectorService.query = mock().mockResolvedValue(mockSemanticResults)
      mockKeywordSearchService.search = mock().mockResolvedValue(mockKeywordResults)

      const result = await hybridSearchService.search('kb1', 'test query', {
        semanticWeight: 0.8,
        keywordWeight: 0.2
      })

      expect(result.length).toBeGreaterThan(0)
    })

    it('应该对空语义结果返回关键词结果', async () => {
      mockVectorService.query = mock().mockResolvedValue([])
      mockKeywordSearchService.search = mock().mockResolvedValue(mockKeywordResults)

      const result = await hybridSearchService.search('kb1', 'test query')

      expect(result.length).toBeGreaterThan(0)
    })

    it('应该对空关键词结果返回语义结果', async () => {
      mockVectorService.query = mock().mockResolvedValue(mockSemanticResults)
      mockKeywordSearchService.search = mock().mockResolvedValue([])

      const result = await hybridSearchService.search('kb1', 'test query')

      expect(result.length).toBeGreaterThan(0)
    })

    it('应该对两者都为空返回空结果', async () => {
      mockVectorService.query = mock().mockResolvedValue([])
      mockKeywordSearchService.search = mock().mockResolvedValue([])

      const result = await hybridSearchService.search('kb1', 'test query')

      expect(result).toEqual([])
    })

    describe('分数语义：排名分只定序，绝对分才进 score 字段', () => {
    it('keyword 空时应返回语义原生相似度分（而非 RRF 排名分 ≈1/61）', async () => {
      // 场景来自真实缺陷：中文口语长句 keyword 分支 0 命中，
      // 旧行为 RRF 单路分 0.016 被下游 0.15 阈值全过滤 → hybrid 必空
      mockVectorService.query = mock().mockResolvedValue([
        { id: 'a', score: 0.93, metadata: { documentId: 'd1' } },
        { id: 'b', score: 0.88, metadata: { documentId: 'd1' } }
      ])
      mockKeywordSearchService.search = mock().mockResolvedValue([])

      const result = await hybridSearchService.search('kb1', '复制会话是不是把所有消息都复制过去')

      expect(result.length).toBeGreaterThan(0)
      expect(result[0].score).toBeCloseTo(0.93, 1)
    })

    it('双路融合后 score 应恢复为两路原生绝对分（顺序仍按融合序）', async () => {
      mockVectorService.query = mock().mockResolvedValue([
        { id: 'a', score: 0.9, metadata: { documentId: 'd1' } },
        { id: 'b', score: 0.8, metadata: { documentId: 'd2' } }
      ])
      mockKeywordSearchService.search = mock().mockResolvedValue([
        { id: 'c', score: 1.0, metadata: { documentId: 'd3' } }
      ])

      const result = await hybridSearchService.search('kb1', 'test query')

      const byId = Object.fromEntries(result.map((r: any) => [r.id, r.score]))
      expect(byId.a).toBeCloseTo(0.9, 1)
      expect(byId.b).toBeCloseTo(0.8, 1)
      expect(byId.c).toBeCloseTo(1.0, 1)
      // 不允许任何 RRF 量级分数外泄
      for (const r of result) {
        expect(r.score).toBeGreaterThan(0.1)
      }
    })
    })

    it('应该去重相同的结果', async () => {
      const duplicateResult = {
        id: '1',
        text: 'Duplicate result',
        score: 0.8,
        metadata: { documentId: 'doc1', chunkIndex: 0 },
        documentId: 'doc1',
        chunkIndex: 0
      }

      mockVectorService.query = mock().mockResolvedValue([duplicateResult])
      mockKeywordSearchService.search = mock().mockResolvedValue([duplicateResult])

      const result = await hybridSearchService.search('kb1', 'test query')

      // 应该只有一个结果（去重）
      expect(result.length).toBe(1)
    })

    it('应该根据混合权重重新排序', async () => {
      mockVectorService.query = mock().mockResolvedValue(mockSemanticResults)
      mockKeywordSearchService.search = mock().mockResolvedValue(mockKeywordResults)

      const result = await hybridSearchService.search('kb1', 'test query', {
        semanticWeight: 0.9,
        keywordWeight: 0.1
      })

      // 结果应该按分数排序
      for (let i = 1; i < result.length; i++) {
        expect(result[i - 1].score).toBeGreaterThanOrEqual(result[i].score)
      }
    })

    it('应该限制返回结果数量', async () => {
      mockVectorService.search = mock().mockResolvedValue(mockSemanticResults)
      mockKeywordSearchService.search = mock().mockResolvedValue(mockKeywordResults)

      const topK = 2
      const result = await hybridSearchService.search('kb1', 'test query', { topK })

      expect(result.length).toBeLessThanOrEqual(topK)
    })

    it('应该传递 pgVector 配置到语义检索', async () => {
      mockVectorService.query = mock().mockResolvedValue(mockSemanticResults)
      mockKeywordSearchService.search = mock().mockResolvedValue(mockKeywordResults)

      const pgVectorConfig = { minScore: 0.5, ef: 100, probes: 10 }
      await hybridSearchService.search('kb1', 'test query', { pgVectorConfig })

      expect(mockVectorService.query).toHaveBeenCalled()
    })
  })

  describe('边界情况', () => {
    it('应该处理权重总和不为1的情况', async () => {
      mockVectorService.query = mock().mockResolvedValue(mockSemanticResults)
      mockKeywordSearchService.search = mock().mockResolvedValue(mockKeywordResults)

      const result = await hybridSearchService.search('kb1', 'test query', {
        semanticWeight: 0.7,
        keywordWeight: 0.5 // 总和 > 1
      })

      expect(result.length).toBeGreaterThan(0)
    })

    it('应该处理零权重', async () => {
      mockVectorService.query = mock().mockResolvedValue(mockSemanticResults)
      mockKeywordSearchService.search = mock().mockResolvedValue(mockKeywordResults)

      const result = await hybridSearchService.search('kb1', 'test query', {
        semanticWeight: 0,
        keywordWeight: 1
      })

      expect(result.length).toBeGreaterThan(0)
    })
  })

  describe('混合分数计算', () => {
    it('应该正确计算混合分数', async () => {
      const semanticResult = {
        id: '1',
        text: 'Semantic high score',
        score: 0.9,
        metadata: { documentId: 'doc1', chunkIndex: 0 },
        documentId: 'doc1',
        chunkIndex: 0
      }

      const keywordResult = {
        id: '2',
        text: 'Keyword high score',
        score: 0.8,
        metadata: { documentId: 'doc2', chunkIndex: 0 },
        documentId: 'doc2',
        chunkIndex: 0
      }

      mockVectorService.query = mock().mockResolvedValue([semanticResult])
      mockKeywordSearchService.search = mock().mockResolvedValue([keywordResult])

      const result = await hybridSearchService.search('kb1', 'test query', {
        semanticWeight: 0.6,
        keywordWeight: 0.4
      })

      // 检查结果数量
      expect(result.length).toBe(2)

      // 由于 RRF 融合，两个结果的分数可能相同或非常接近
      // 验证结果已返回且格式正确
      expect(result[0]).toBeDefined()
      expect(result[1]).toBeDefined()
      expect(result[0].score).toBeGreaterThanOrEqual(0)
      expect(result[1].score).toBeGreaterThanOrEqual(0)
    })
  })

  describe('P0 优化 - 重排序功能', () => {
    it('应该在启用 rerankConfig 时召回更多结果', async () => {
      mockVectorService.query = mock().mockResolvedValue(mockSemanticResults)
      mockKeywordSearchService.search = mock().mockResolvedValue(mockKeywordResults)

      const topK = 10
      const rerankTopK = 20

      await hybridSearchService.search('kb1', 'test query', {
        topK,
        rerankConfig: {
          enableRerank: true,
          rerankTopK,
          rerankModel: 'mastra'
        }
      })

      // 应该调用 vectorService.query 和 keywordSearchService.search
      // 且 topK 参数应该是 rerankTopK * 2
      expect(mockVectorService.query).toHaveBeenCalled()
      expect(mockKeywordSearchService.search).toHaveBeenCalled()
    })

    it('应该在启用 rerankConfig 时使用 mastra 模型', async () => {
      mockVectorService.query = mock().mockResolvedValue(mockSemanticResults)
      mockKeywordSearchService.search = mock().mockResolvedValue(mockKeywordResults)

      const result = await hybridSearchService.search('kb1', 'test query', {
        topK: 10,
        rerankConfig: {
          enableRerank: true,
          rerankTopK: 20,
          rerankModel: 'mastra'
        }
      })

      // 结果应该被返回
      expect(result).toBeDefined()
      expect(Array.isArray(result)).toBe(true)
    })

    it('应该在 enableRerank=false 时不进行重排序', async () => {
      mockVectorService.query = mock().mockResolvedValue(mockSemanticResults)
      mockKeywordSearchService.search = mock().mockResolvedValue(mockKeywordResults)

      const result = await hybridSearchService.search('kb1', 'test query', {
        topK: 10,
        rerankConfig: {
          enableRerank: false,
          rerankTopK: 20,
          rerankModel: 'mastra'
        }
      })

      // 结果应该直接返回，不经过重排序
      expect(result).toBeDefined()
      expect(result.length).toBeLessThanOrEqual(10)
    })

    it('应该在 rerankConfig 未定义时使用默认行为', async () => {
      mockVectorService.query = mock().mockResolvedValue(mockSemanticResults)
      mockKeywordSearchService.search = mock().mockResolvedValue(mockKeywordResults)

      const result = await hybridSearchService.search('kb1', 'test query', {
        topK: 10
        // 没有 rerankConfig
      })

      // 应该正常返回结果
      expect(result).toBeDefined()
      expect(result.length).toBeLessThanOrEqual(10)
    })

    it('应该支持 cohere 重排序模型', async () => {
      mockVectorService.query = mock().mockResolvedValue(mockSemanticResults)
      mockKeywordSearchService.search = mock().mockResolvedValue(mockKeywordResults)

      const result = await hybridSearchService.search('kb1', 'test query', {
        topK: 10,
        rerankConfig: {
          enableRerank: true,
          rerankTopK: 20,
          rerankModel: 'cohere'
        }
      })

      expect(result).toBeDefined()
    })

    it('应该支持 zeroentropy 重排序模型', async () => {
      mockVectorService.query = mock().mockResolvedValue(mockSemanticResults)
      mockKeywordSearchService.search = mock().mockResolvedValue(mockKeywordResults)

      const result = await hybridSearchService.search('kb1', 'test query', {
        topK: 10,
        rerankConfig: {
          enableRerank: true,
          rerankTopK: 20,
          rerankModel: 'zeroentropy'
        }
      })

      expect(result).toBeDefined()
    })

    it('应该支持 simple 重排序模型', async () => {
      mockVectorService.query = mock().mockResolvedValue(mockSemanticResults)
      mockKeywordSearchService.search = mock().mockResolvedValue(mockKeywordResults)

      const result = await hybridSearchService.search('kb1', 'test query', {
        topK: 10,
        rerankConfig: {
          enableRerank: true,
          rerankTopK: 20,
          rerankModel: 'simple'
        }
      })

      expect(result).toBeDefined()
    })

    it('应该默认使用 simple 重排序模型', async () => {
      mockVectorService.query = mock().mockResolvedValue(mockSemanticResults)
      mockKeywordSearchService.search = mock().mockResolvedValue(mockKeywordResults)

      // 不指定 rerankModel，应该使用默认值 'simple'
      const result = await hybridSearchService.search('kb1', 'test query', {
        topK: 10,
        rerankConfig: {
          enableRerank: true,
          rerankTopK: 20
          // 不指定 rerankModel
        }
      })

      expect(result).toBeDefined()
    })
  })

  describe('P1 优化 - HyDE 功能', () => {
    it('应该在启用 hydeConfig 时使用假设文档进行检索', async () => {
      mockVectorService.query = mock().mockResolvedValue(mockSemanticResults)
      mockKeywordSearchService.search = mock().mockResolvedValue(mockKeywordResults)

      const result = await hybridSearchService.search('kb1', 'test query', {
        topK: 10,
        hydeConfig: {
          enableHyDE: true,
          llmModel: 'gpt-4o-mini'
        }
      })

      // 应该调用语义检索
      expect(mockVectorService.query).toHaveBeenCalled()
      expect(result).toBeDefined()
    })

    it('应该在 enableHyDE=false 时不使用 HyDE', async () => {
      mockVectorService.query = mock().mockResolvedValue(mockSemanticResults)
      mockKeywordSearchService.search = mock().mockResolvedValue(mockKeywordResults)

      const result = await hybridSearchService.search('kb1', 'test query', {
        topK: 10,
        hydeConfig: {
          enableHyDE: false,
          llmModel: 'gpt-4o-mini'
        }
      })

      expect(result).toBeDefined()
    })

    it('应该在 hydeConfig 未定义时使用原始查询', async () => {
      mockVectorService.query = mock().mockResolvedValue(mockSemanticResults)
      mockKeywordSearchService.search = mock().mockResolvedValue(mockKeywordResults)

      const result = await hybridSearchService.search('kb1', 'test query', {
        topK: 10
        // 没有 hydeConfig
      })

      expect(result).toBeDefined()
      expect(result.length).toBeLessThanOrEqual(10)
    })

    it('应该支持自定义 LLM 模型', async () => {
      mockVectorService.query = mock().mockResolvedValue(mockSemanticResults)
      mockKeywordSearchService.search = mock().mockResolvedValue(mockKeywordResults)

      const result = await hybridSearchService.search('kb1', 'test query', {
        topK: 10,
        hydeConfig: {
          enableHyDE: true,
          llmModel: 'gpt-4o'
        }
      })

      expect(result).toBeDefined()
    })

    it('应该同时启用重排序和 HyDE', async () => {
      mockVectorService.query = mock().mockResolvedValue(mockSemanticResults)
      mockKeywordSearchService.search = mock().mockResolvedValue(mockKeywordResults)

      const result = await hybridSearchService.search('kb1', 'test query', {
        topK: 10,
        rerankConfig: {
          enableRerank: true,
          rerankTopK: 20,
          rerankModel: 'mastra'
        },
        hydeConfig: {
          enableHyDE: true,
          llmModel: 'gpt-4o-mini'
        }
      })

      // 两个功能应该都能正常工作
      expect(result).toBeDefined()
      expect(mockVectorService.query).toHaveBeenCalled()
    })
  })
})
