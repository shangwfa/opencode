/**
 * RerankService 单元测试
 * 测试重排序功能
 */

import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test'
type RerankService = import('./rerank.service').RerankService
import type { SearchResultItem } from '../types/knowledge-base.types'

// Mock ai 模块（rerank 'mastra' 模式经 generateText 走 LLM 打分）
mock.module('ai', () => ({
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

// Mock time-decay 模块
mock.module('../../../utils/time-decay.js', () => ({
  calculateTimeDecayBonus: mock(() => 0.1)
}))

mock.module('../../../config/time-decay.config.js', () => ({
  getActiveTimeDecayConfig: mock(() => ({
    decayRate: 0.1,
    halfLife: 30
  }))
}))

// 被测模块：mock 注册后动态导入
const { RerankService } = await import('./rerank.service')

describe('RerankService', () => {
  let rerankService: RerankService
  let mockResults: SearchResultItem[]

  beforeEach(() => {
    rerankService = new RerankService()
    mockResults = [
      {
        id: '1',
        text: 'Python programming guide',
        score: 0.8,
        metadata: {
          documentId: 'doc1',
          chunkIndex: 0,
          text: 'Python programming guide',
          docPath: '/tutorial/python',
          docName: 'Python Guide',
          syncedAt: new Date().toISOString()
        },
        documentId: 'doc1',
        chunkIndex: 0
      },
      {
        id: '2',
        text: 'JavaScript basics',
        score: 0.7,
        metadata: {
          documentId: 'doc2',
          chunkIndex: 0,
          text: 'JavaScript basics',
          docPath: '/tutorial/js',
          docName: 'JS Basics',
          syncedAt: new Date().toISOString()
        },
        documentId: 'doc2',
        chunkIndex: 0
      },
      {
        id: '3',
        text: 'Python advanced features',
        score: 0.6,
        metadata: {
          documentId: 'doc1',
          chunkIndex: 1,
          text: 'Python advanced features',
          docPath: '/advanced/python',
          docName: 'Python Advanced',
          syncedAt: new Date().toISOString()
        },
        documentId: 'doc1',
        chunkIndex: 1
      }
    ]
  })

  describe('llm 模型（绝对相关性打分）', () => {
    it("model='llm' 应走 LLM 打分并以相关性分作为最终 score", async () => {
      const result = await rerankService.rerank('python guide', mockResults, { model: 'llm', topK: 3 })
      // mock 的 generateText 恒返回 '0.8' → LLM 分数应写入 score
      expect(result.length).toBeGreaterThan(0)
      for (const item of result) {
        expect(item.score).toBeCloseTo(0.8)
      }
    })

    it("model='mastra' 与 'llm' 行为一致（兼容旧枚举）", async () => {
      const result = await rerankService.rerank('python guide', mockResults, { model: 'mastra', topK: 3 })
      expect(result.length).toBeGreaterThan(0)
      expect(result[0].score).toBeCloseTo(0.8)
    })
  })

  describe('simple 改分语义（输入恒为绝对分，输出仍具绝对语义）', () => {
    it('返回结果的 score 为 0.6×输入 + 0.2×关键词覆盖 + 元信息加成', async () => {
      const result = await rerankService.rerank('python guide', mockResults, { model: 'simple', topK: 3 })
      const byId = Object.fromEntries(result.map((r: any) => [r.id, r.score]))
      // id=1: 0.8×0.6 + 覆盖(python 命中) + 元信息(docPath 含 query → +0.15, docName 命中 → +0.2, timeDecay mock → +0.1, 层级 +0.02)
      expect(byId['1']).toBeGreaterThan(0.6 * 0.8)
      expect(byId['2']).toBeGreaterThan(0.6 * 0.7)
      expect(byId['3']).toBeGreaterThan(0.6 * 0.6)
    })

    it('排序应反映查询相关性（关键词命中优先）', async () => {
      const result = await rerankService.rerank('python guide', mockResults, { model: 'simple', topK: 3 })
      const ids = result.map((r: any) => r.id)
      expect(ids.indexOf('2')).toBeGreaterThan(ids.indexOf('1'))
      expect(ids.indexOf('2')).toBeGreaterThan(ids.indexOf('3'))
    })

    it('词法信号兜底：cosine 为 0 但查询为块文本子串时分数应过质量阈值', async () => {
      // 场景来自 e2e 伪向量回归：token 零重叠 → cosine=0，
      // 但"配置数据库连接"是块文本子串 → 词法覆盖 1.0 + earlyMatch → 0.3 > 0.2
      const lexicalResults = [
        {
          id: 'cfg',
          text: '## 配置\n配置数据库连接字符串以启用存储。',
          score: 0,
          metadata: { documentId: 'doc', chunkIndex: 0, text: '## 配置\n配置数据库连接字符串以启用存储。' }
        }
      ] as any[]
      const result = await rerankService.rerank('配置数据库连接', lexicalResults, { model: 'simple', topK: 1 })
      expect(result[0].score).toBeGreaterThan(0.2)
    })
  })

  describe('初始化', () => {
    it('应该成功创建实例', () => {
      expect(rerankService).toBeInstanceOf(RerankService)
    })
  })

  describe('默认行为', () => {
    it('应该默认使用 simple 模型（简化重排）', async () => {
      const query = 'Python'
      const result = await rerankService.rerank(query, mockResults)

      // 默认应该使用简化重排，Python 相关的结果应该排名更高
      expect(result.length).toBeGreaterThan(0)
      expect(result[0].text).toContain('Python')
    })

    it('应该在没有指定模型时使用 simple 作为默认值', async () => {
      const query = 'Python programming'
      const result1 = await rerankService.rerank(query, mockResults) // 不指定模型
      const result2 = await rerankService.rerank(query, mockResults, { model: 'simple' }) // 明确指定 simple

      // 两种方式应该产生相同的结果（都使用简化重排）
      expect(result1.length).toBe(result2.length)
      expect(result1[0].id).toBe(result2[0].id)
    })
  })

  describe('simple 模型', () => {
    it('应该支持 simple 模型选项', async () => {
      const query = 'Python'
      const result = await rerankService.rerank(query, mockResults, { model: 'simple' })

      expect(result.length).toBeGreaterThan(0)
      expect(result[0].text).toContain('Python')
    })

    it('simple 模型应该使用简化重排逻辑', async () => {
      const query = 'Python'
      const result = await rerankService.rerank(query, mockResults, { model: 'simple' })

      // 应该根据关键词匹配、文档名匹配等进行重排
      const pythonResults = result.filter((r) => r.text.includes('Python'))
      expect(pythonResults.length).toBeGreaterThan(0)
    })

    it('simple 模型应该与 zeroentropy 模型行为一致', async () => {
      const query = 'Python programming'
      const resultSimple = await rerankService.rerank(query, mockResults, { model: 'simple' })
      const resultZeroEntropy = await rerankService.rerank(query, mockResults, { model: 'zeroentropy' })

      // 两种模型都应该使用简化重排，结果应该一致
      expect(resultSimple.length).toBe(resultZeroEntropy.length)
      expect(resultSimple[0].id).toBe(resultZeroEntropy[0].id)
    })

    it('simple 模型应该支持 topK 参数', async () => {
      const query = 'test'
      const result = await rerankService.rerank(query, mockResults, {
        model: 'simple',
        topK: 2
      })

      expect(result.length).toBeLessThanOrEqual(2)
    })
  })

  describe('simpleRerank - 简化重排序', () => {
    it('应该对空结果数组返回空数组', async () => {
      const query = 'test query'
      const result = await rerankService.rerank(query, [])

      expect(result).toEqual([])
    })

    it('应该根据关键词匹配度重新排序', async () => {
      const query = 'Python programming'
      const result = await rerankService.rerank(query, mockResults, { model: 'zeroentropy' })

      // Python 相关的结果应该排名更高
      expect(result.length).toBeGreaterThan(0)
      expect(result[0].text).toContain('Python')
    })

    it('应该根据文档名匹配加分', async () => {
      const query = 'Python'
      const result = await rerankService.rerank(query, mockResults, { model: 'zeroentropy' })

      // 文档名包含 'Python' 的应该有更高的分数
      const pythonGuideResult = result.find((r) => r.metadata?.docName?.includes('Python'))
      const jsBasicsResult = result.find((r) => r.metadata?.docName?.includes('JS'))

      expect(pythonGuideResult).toBeDefined()
      if (pythonGuideResult && jsBasicsResult) {
        expect(pythonGuideResult.score).toBeGreaterThan(jsBasicsResult.score)
      }
    })

    it('应该根据路径匹配加分', async () => {
      const query = 'tutorial'
      const result = await rerankService.rerank(query, mockResults, { model: 'zeroentropy' })

      // 路径包含 'tutorial' 的应该有更高的分数
      const tutorialResults = result.filter((r) => r.metadata?.docPath?.includes('tutorial'))
      expect(tutorialResults.length).toBeGreaterThan(0)
    })

    it('应该根据关键词出现位置加分', async () => {
      const query = 'programming'
      const result = await rerankService.rerank(query, mockResults, { model: 'zeroentropy' })

      // 关键词出现早的应该加分
      const programmingResult = result.find((r) => r.text.includes('programming'))
      expect(programmingResult).toBeDefined()
    })

    it('应该限制返回结果数量', async () => {
      const query = 'test'
      const result = await rerankService.rerank(query, mockResults, { topK: 2, model: 'zeroentropy' })

      expect(result.length).toBeLessThanOrEqual(2)
    })

    it('应该保持结果分数在 0-1 之间', async () => {
      const query = 'test'
      const result = await rerankService.rerank(query, mockResults, { model: 'zeroentropy' })

      result.forEach((item) => {
        expect(item.score).toBeGreaterThanOrEqual(0)
        expect(item.score).toBeLessThanOrEqual(1)
      })
    })

    it('应该根据路径深度加分', async () => {
      const query = 'test'
      const shallowResults = [
        {
          id: '1',
          text: 'Shallow content',
          score: 0.5,
          metadata: {
            documentId: 'doc1',
            chunkIndex: 0,
            text: 'Shallow content',
            docPath: '/top' // 浅层路径
          },
          documentId: 'doc1',
          chunkIndex: 0
        },
        {
          id: '2',
          text: 'Deep content',
          score: 0.5,
          metadata: {
            documentId: 'doc2',
            chunkIndex: 0,
            text: 'Deep content',
            docPath: '/deep/nested/path/level' // 深层路径
          },
          documentId: 'doc2',
          chunkIndex: 0
        }
      ]

      const result = await rerankService.rerank(query, shallowResults, { model: 'zeroentropy' })

      // 浅层路径应该有更高的分数
      const shallowResult = result.find((r) => r.metadata?.docPath === '/top')
      const deepResult = result.find((r) => r.metadata?.docPath?.includes('level'))

      if (shallowResult && deepResult) {
        expect(shallowResult.score).toBeGreaterThan(deepResult.score)
      }
    })

    it('应该计算关键词覆盖率', async () => {
      const query = 'Python programming tutorial'
      const result = await rerankService.rerank(query, mockResults, { model: 'zeroentropy' })

      // 包含更多关键词的结果应该分数更高
      expect(result.length).toBeGreaterThan(0)
    })
  })

  describe('边界情况', () => {
    it('应该处理查询为空字符串', async () => {
      const result = await rerankService.rerank('', mockResults, { model: 'zeroentropy' })

      expect(result.length).toBe(mockResults.length)
    })

    it('应该处理单字符查询', async () => {
      const result = await rerankService.rerank('a', mockResults, { model: 'zeroentropy' })

      // 单字符会被过滤掉（length <= 1）
      expect(result.length).toBeGreaterThan(0)
    })

    it('应该处理没有元数据的结果', async () => {
      const noMetadataResults = [
        {
          id: '1',
          text: 'Test content',
          score: 0.5,
          metadata: {},
          documentId: '',
          chunkIndex: undefined
        }
      ]

      const result = await rerankService.rerank('test', noMetadataResults, { model: 'zeroentropy' })

      expect(result.length).toBe(1)
    })

    it('应该处理缺少 text 字段的元数据', async () => {
      const noTextResults = [
        {
          id: '1',
          text: 'Original text',
          score: 0.5,
          metadata: {
            documentId: 'doc1',
            chunkIndex: 0
          },
          documentId: 'doc1',
          chunkIndex: 0
        }
      ]

      const result = await rerankService.rerank('test', noTextResults, { model: 'zeroentropy' })

      expect(result.length).toBe(1)
    })

    it('应该处理相同分数的结果', async () => {
      const sameScoreResults = [
        {
          id: '1',
          text: 'First result',
          score: 0.5,
          metadata: {
            documentId: 'doc1',
            chunkIndex: 0,
            text: 'First result'
          },
          documentId: 'doc1',
          chunkIndex: 0
        },
        {
          id: '2',
          text: 'Second result',
          score: 0.5,
          metadata: {
            documentId: 'doc2',
            chunkIndex: 0,
            text: 'Second result'
          },
          documentId: 'doc2',
          chunkIndex: 0
        }
      ]

      const query = 'first'
      const result = await rerankService.rerank(query, sameScoreResults, { model: 'zeroentropy' })

      // 'first' 应该匹配第一个结果并提升其分数
      expect(result[0].text).toBe('First result')
      expect(result[0].score).toBeGreaterThan(0.5)
    })
  })

  describe('topK 参数', () => {
    it('应该使用默认 topK=20', async () => {
      const largeResults = Array.from({ length: 30 }, (_, i) => ({
        id: `${i}`,
        text: `Result ${i}`,
        score: 0.5,
        metadata: {
          documentId: `doc${i}`,
          chunkIndex: 0,
          text: `Result ${i}`
        },
        documentId: `doc${i}`,
        chunkIndex: 0
      }))

      const result = await rerankService.rerank('test', largeResults, { model: 'zeroentropy' })

      expect(result.length).toBeLessThanOrEqual(20)
    })

    it('应该使用自定义 topK', async () => {
      const customTopK = 5
      const result = await rerankService.rerank('test', mockResults, {
        topK: customTopK,
        model: 'zeroentropy'
      })

      expect(result.length).toBeLessThanOrEqual(customTopK)
    })

    it('应该处理 topK=0', async () => {
      const result = await rerankService.rerank('test', mockResults, {
        topK: 0,
        model: 'zeroentropy'
      })

      expect(result.length).toBe(0)
    })

    it('应该处理 topK 大于结果数量', async () => {
      const result = await rerankService.rerank('test', mockResults, {
        topK: 100,
        model: 'zeroentropy'
      })

      expect(result.length).toBe(mockResults.length)
    })
  })
})
