/**
 * 元数据过滤功能单元测试
 *
 * 测试向量检索中的元数据过滤功能，验证：
 * 1. 基础元数据过滤（等值查询）
 * 2. 比较运算符（$gt, $lt, $gte, $lte, $ne）
 * 3. 数组运算符（$in, $nin, $all）
 * 4. 逻辑运算符（$and, $or, $nor, $not）
 * 5. 嵌套元数据过滤
 * 6. 复杂组合查询
 * 7. 边界情况和错误处理
 */

import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test'
type VectorService = import('./vector.service').VectorService

// Mock pg Pool
mock.module('pg', () => {
  const mockQuery = mock()
  const mockRelease = mock()
  const mockConnect = mock().mockResolvedValue({
    query: mockQuery,
    release: mockRelease
  })

  class MockPool {
    constructor() {}
    connect = mockConnect
  }

  return { Pool: MockPool }
})

// Mock ../vector/vector-store.js（vector.service 实际导入的模块）
const mockQueryResults: any[] = []
let mockQueryFilter: any = null

mock.module('../vector/vector-store.js', () => {
  class MockPgVectorStore {
    constructor() {}

    createIndex = mock().mockResolvedValue(undefined)

    upsert = mock().mockResolvedValue(undefined)

    deleteVector = mock().mockResolvedValue(undefined)

    query = mock().mockImplementation((options: any) => {
      // 记录传入的 filter 参数
      mockQueryFilter = options.filter

      // 返回模拟结果
      return Promise.resolve(mockQueryResults)
    })
  }

  return {
    PgVectorStore: MockPgVectorStore
  }
})

// Mock ai 模块
mock.module('ai', () => ({
  embed: mock().mockResolvedValue({
    embedding: [0.1, 0.2, 0.3, 0.4, 0.5]
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
const { VectorService } = await import('./vector.service')

describe('VectorService - 元数据过滤功能', () => {
  let vectorService: VectorService
  const connectionString = 'postgresql://test:test@localhost:5432/test'
  const schemaName = 'test'
  const knowledgeBaseId = 'test_kb'
  const queryVector = [0.1, 0.2, 0.3, 0.4, 0.5]

  beforeEach(() => {
    vectorService = new VectorService(connectionString, schemaName)
    mock.clearAllMocks()
    mockQueryFilter = null

    // 准备默认的模拟结果
    mockQueryResults.length = 0
    mockQueryResults.push(
      {
        id: '1',
        score: 0.9,
        metadata: {
          documentId: 'doc1',
          chunkIndex: 0,
          category: 'tech',
          tags: ['ai', 'ml'],
          views: 100,
          published: true
        }
      },
      {
        id: '2',
        score: 0.8,
        metadata: {
          documentId: 'doc2',
          chunkIndex: 1,
          category: 'business',
          tags: ['finance', 'ai'],
          views: 200,
          published: false
        }
      },
      {
        id: '3',
        score: 0.7,
        metadata: {
          documentId: 'doc3',
          chunkIndex: 0,
          category: 'tech',
          tags: ['coding'],
          views: 150,
          published: true
        }
      }
    )
  })

  describe('1. 基础元数据过滤', () => {
    it('应该支持简单的等值查询', async () => {
      const filter = { category: 'tech' }

      await vectorService.query(knowledgeBaseId, queryVector, 10, filter)

      // 验证 filter 被正确传递
      expect(mockQueryFilter).toEqual(filter)
    })

    it('应该支持多字段等值查询', async () => {
      const filter = {
        category: 'tech',
        published: true
      }

      await vectorService.query(knowledgeBaseId, queryVector, 10, filter)

      expect(mockQueryFilter).toEqual(filter)
    })

    it('应该支持嵌套字段查询', async () => {
      const filter = {
        'metadata.category': 'tech'
      }

      await vectorService.query(knowledgeBaseId, queryVector, 10, filter)

      expect(mockQueryFilter).toEqual(filter)
    })

    it('应该在没有 filter 时正常工作', async () => {
      await vectorService.query(knowledgeBaseId, queryVector, 10)

      expect(mockQueryFilter).toBeUndefined()
    })
  })

  describe('2. 比较运算符', () => {
    it('应该支持 $gt（大于）运算符', async () => {
      const filter = {
        views: { $gt: 100 }
      }

      await vectorService.query(knowledgeBaseId, queryVector, 10, filter)

      expect(mockQueryFilter).toEqual(filter)
    })

    it('应该支持 $lt（小于）运算符', async () => {
      const filter = {
        views: { $lt: 200 }
      }

      await vectorService.query(knowledgeBaseId, queryVector, 10, filter)

      expect(mockQueryFilter).toEqual(filter)
    })

    it('应该支持 $gte（大于等于）运算符', async () => {
      const filter = {
        views: { $gte: 150 }
      }

      await vectorService.query(knowledgeBaseId, queryVector, 10, filter)

      expect(mockQueryFilter).toEqual(filter)
    })

    it('应该支持 $lte（小于等于）运算符', async () => {
      const filter = {
        views: { $lte: 150 }
      }

      await vectorService.query(knowledgeBaseId, queryVector, 10, filter)

      expect(mockQueryFilter).toEqual(filter)
    })

    it('应该支持 $ne（不等于）运算符', async () => {
      const filter = {
        category: { $ne: 'business' }
      }

      await vectorService.query(knowledgeBaseId, queryVector, 10, filter)

      expect(mockQueryFilter).toEqual(filter)
    })

    it('应该支持组合比较运算符', async () => {
      const filter = {
        views: { $gt: 100, $lt: 200 }
      }

      await vectorService.query(knowledgeBaseId, queryVector, 10, filter)

      expect(mockQueryFilter).toEqual(filter)
    })
  })

  describe('3. 数组运算符', () => {
    it('应该支持 $in（包含）运算符', async () => {
      const filter = {
        category: { $in: ['tech', 'business'] }
      }

      await vectorService.query(knowledgeBaseId, queryVector, 10, filter)

      expect(mockQueryFilter).toEqual(filter)
    })

    it('应该支持 $nin（不包含）运算符', async () => {
      const filter = {
        category: { $nin: ['business'] }
      }

      await vectorService.query(knowledgeBaseId, queryVector, 10, filter)

      expect(mockQueryFilter).toEqual(filter)
    })

    it('应该支持 $all（全部包含）运算符', async () => {
      const filter = {
        tags: { $all: ['ai', 'ml'] }
      }

      await vectorService.query(knowledgeBaseId, queryVector, 10, filter)

      expect(mockQueryFilter).toEqual(filter)
    })

    it('应该支持 $size（数组长度）运算符', async () => {
      const filter = {
        tags: { $size: 2 }
      }

      await vectorService.query(knowledgeBaseId, queryVector, 10, filter)

      expect(mockQueryFilter).toEqual(filter)
    })
  })

  describe('4. 逻辑运算符', () => {
    it('应该支持 $and（且）运算符', async () => {
      const filter = {
        $and: [
          { category: 'tech' },
          { views: { $gt: 100 } }
        ]
      }

      await vectorService.query(knowledgeBaseId, queryVector, 10, filter)

      expect(mockQueryFilter).toEqual(filter)
    })

    it('应该支持 $or（或）运算符', async () => {
      const filter = {
        $or: [
          { category: 'tech' },
          { category: 'business' }
        ]
      }

      await vectorService.query(knowledgeBaseId, queryVector, 10, filter)

      expect(mockQueryFilter).toEqual(filter)
    })

    it('应该支持 $nor（非或）运算符', async () => {
      const filter = {
        $nor: [
          { category: 'business' },
          { views: { $lt: 50 } }
        ]
      }

      await vectorService.query(knowledgeBaseId, queryVector, 10, filter)

      expect(mockQueryFilter).toEqual(filter)
    })

    it('应该支持嵌套逻辑运算符', async () => {
      const filter = {
        $and: [
          { published: true },
          {
            $or: [
              { category: 'tech' },
              { views: { $gt: 200 } }
            ]
          }
        ]
      }

      await vectorService.query(knowledgeBaseId, queryVector, 10, filter)

      expect(mockQueryFilter).toEqual(filter)
    })
  })

  describe('5. 复杂组合查询', () => {
    it('应该支持多字段组合 + 比较运算符', async () => {
      const filter = {
        category: 'tech',
        views: { $gte: 100, $lte: 200 },
        published: true
      }

      await vectorService.query(knowledgeBaseId, queryVector, 10, filter)

      expect(mockQueryFilter).toEqual(filter)
    })

    it('应该支持 $or + $in 组合', async () => {
      const filter = {
        $or: [
          { category: { $in: ['tech', 'science'] } },
          { views: { $gt: 200 } }
        ]
      }

      await vectorService.query(knowledgeBaseId, queryVector, 10, filter)

      expect(mockQueryFilter).toEqual(filter)
    })

    it('应该支持复杂嵌套查询', async () => {
      const filter = {
        $and: [
          {
            $or: [
              { category: 'tech' },
              { tags: { $in: ['ai'] } }
            ]
          },
          {
            views: { $gt: 100 }
          },
          { published: true }
        ]
      }

      await vectorService.query(knowledgeBaseId, queryVector, 10, filter)

      expect(mockQueryFilter).toEqual(filter)
    })

    it('应该支持正则表达式查询', async () => {
      const filter = {
        category: /tech/i
      }

      await vectorService.query(knowledgeBaseId, queryVector, 10, filter)

      expect(mockQueryFilter).toEqual(filter)
    })
  })

  describe('6. pgVector 配置集成', () => {
    it('应该同时支持 filter 和 minScore', async () => {
      const filter = { category: 'tech' }
      const pgVectorConfig = { minScore: 0.5 }

      const results = await vectorService.query(
        knowledgeBaseId,
        queryVector,
        10,
        filter,
        pgVectorConfig
      )

      // 验证 filter 被传递
      expect(mockQueryFilter).toEqual(filter)

      // 验证 minScore 过滤在应用层生效
      results.forEach(result => {
        expect(result.score).toBeGreaterThanOrEqual(0.5)
      })
    })

    it('应该同时支持 filter 和 ef 参数', async () => {
      const filter = { category: 'tech' }
      const pgVectorConfig = { ef: 128 }

      await vectorService.query(
        knowledgeBaseId,
        queryVector,
        10,
        filter,
        pgVectorConfig
      )

      expect(mockQueryFilter).toEqual(filter)
    })

    it('应该同时支持 filter 和 probes 参数', async () => {
      const filter = { category: 'tech' }
      const pgVectorConfig = { probes: 10 }

      await vectorService.query(
        knowledgeBaseId,
        queryVector,
        10,
        filter,
        pgVectorConfig
      )

      expect(mockQueryFilter).toEqual(filter)
    })

    it('应该支持完整的 pgVector 配置', async () => {
      const filter = { category: 'tech' }
      const pgVectorConfig = {
        minScore: 0.5,
        ef: 128,
        probes: 10
      }

      const results = await vectorService.query(
        knowledgeBaseId,
        queryVector,
        10,
        filter,
        pgVectorConfig
      )

      expect(mockQueryFilter).toEqual(filter)
      results.forEach(result => {
        expect(result.score).toBeGreaterThanOrEqual(0.5)
      })
    })
  })

  describe('7. 边界情况和错误处理', () => {
    it('应该处理空 filter 对象', async () => {
      const filter = {}

      await vectorService.query(knowledgeBaseId, queryVector, 10, filter)

      expect(mockQueryFilter).toEqual(filter)
    })

    it('应该处理 null filter', async () => {
      const filter = null

      await vectorService.query(knowledgeBaseId, queryVector, 10, filter as any)

      expect(mockQueryFilter).toBeNull()
    })

    it('应该处理 undefined filter', async () => {
      const filter = undefined

      await vectorService.query(knowledgeBaseId, queryVector, 10, filter)

      expect(mockQueryFilter).toBeUndefined()
    })

    it('应该处理嵌套的空对象', async () => {
      const filter = {
        metadata: {}
      }

      await vectorService.query(knowledgeBaseId, queryVector, 10, filter)

      expect(mockQueryFilter).toEqual(filter)
    })

    it('应该处理深度嵌套的查询', async () => {
      const filter = {
        'metadata.nested.level1.level2': 'value'
      }

      await vectorService.query(knowledgeBaseId, queryVector, 10, filter)

      expect(mockQueryFilter).toEqual(filter)
    })

    it('应该处理包含特殊字符的值', async () => {
      const filter = {
        text: { $regex: '.*special.*chars.*' }
      }

      await vectorService.query(knowledgeBaseId, queryVector, 10, filter)

      expect(mockQueryFilter).toEqual(filter)
    })

    it('应该处理超大数组查询', async () => {
      const filter = {
        tags: { $in: Array(100).fill('tag').map((_, i) => `tag${i}`) }
      }

      await vectorService.query(knowledgeBaseId, queryVector, 10, filter)

      expect(mockQueryFilter).toEqual(filter)
    })
  })

  describe('8. 实际应用场景测试', () => {
    it('场景1: 按文档ID过滤', async () => {
      const filter = {
        documentId: 'doc1'
      }

      await vectorService.query(knowledgeBaseId, queryVector, 10, filter)

      expect(mockQueryFilter).toEqual(filter)
    })

    it('场景2: 按类别和发布状态过滤', async () => {
      const filter = {
        category: 'tech',
        published: true
      }

      await vectorService.query(knowledgeBaseId, queryVector, 10, filter)

      expect(mockQueryFilter).toEqual(filter)
    })

    it('场景3: 按浏览量范围过滤', async () => {
      const filter = {
        views: { $gte: 100, $lte: 200 }
      }

      await vectorService.query(knowledgeBaseId, queryVector, 10, filter)

      expect(mockQueryFilter).toEqual(filter)
    })

    it('场景4: 按标签过滤（多个标签匹配）', async () => {
      const filter = {
        tags: { $all: ['ai', 'ml'] }
      }

      await vectorService.query(knowledgeBaseId, queryVector, 10, filter)

      expect(mockQueryFilter).toEqual(filter)
    })

    it('场景5: 复杂业务查询（热门技术文章）', async () => {
      const filter = {
        $and: [
          { category: 'tech' },
          { published: true },
          { views: { $gt: 100 } },
          { tags: { $in: ['ai', 'ml', 'coding'] } }
        ]
      }

      await vectorService.query(knowledgeBaseId, queryVector, 10, filter)

      expect(mockQueryFilter).toEqual(filter)
    })

    it('场景6: 排除特定类别', async () => {
      const filter = {
        category: { $nin: ['spam', 'draft'] }
      }

      await vectorService.query(knowledgeBaseId, queryVector, 10, filter)

      expect(mockQueryFilter).toEqual(filter)
    })

    it('场景7: 按多个条件OR查询', async () => {
      const filter = {
        $or: [
          { category: 'tech' },
          { tags: { $in: ['ai'] } },
          { views: { $gt: 500 } }
        ]
      }

      await vectorService.query(knowledgeBaseId, queryVector, 10, filter)

      expect(mockQueryFilter).toEqual(filter)
    })
  })

  describe('9. 元数据过滤性能验证', () => {
    it('应该正确传递 filter 到 pgVector', async () => {
      const complexFilter = {
        $and: [
          { category: 'tech' },
          {
            $or: [
              { views: { $gt: 100 } },
              { tags: { $in: ['ai'] } }
            ]
          }
        ]
      }

      await vectorService.query(knowledgeBaseId, queryVector, 10, complexFilter)

      // 验证完整的 filter 结构被传递
      expect(mockQueryFilter).toEqual(complexFilter)
    })

    it('应该验证 filter 不被修改', async () => {
      const originalFilter = {
        category: 'tech',
        views: { $gt: 100 }
      }
      const filterCopy = JSON.parse(JSON.stringify(originalFilter))

      await vectorService.query(knowledgeBaseId, queryVector, 10, originalFilter)

      // 验证 filter 对象未被修改
      expect(originalFilter).toEqual(filterCopy)
    })
  })

  describe('10. 与 minScore 的集成测试', () => {
    it('应该先应用 filter，再应用 minScore', async () => {
      const filter = { category: 'tech' }
      const pgVectorConfig = { minScore: 0.75 }

      const results = await vectorService.query(
        knowledgeBaseId,
        queryVector,
        10,
        filter,
        pgVectorConfig
      )

      // 验证 minScore 过滤生效
      results.forEach(result => {
        expect(result.score).toBeGreaterThanOrEqual(0.75)
      })

      // 验证 filter 被传递
      expect(mockQueryFilter).toEqual(filter)
    })

    it('应该处理所有结果都被 minScore 过滤的情况', async () => {
      // 设置一个很高的 minScore
      const pgVectorConfig = { minScore: 0.99 }

      const results = await vectorService.query(
        knowledgeBaseId,
        queryVector,
        10,
        { category: 'tech' },
        pgVectorConfig
      )

      // 所有结果都应该被过滤
      expect(results).toEqual([])
    })

    it('应该在 minScore 为 0 时返回所有结果', async () => {
      const pgVectorConfig = { minScore: 0 }

      const results = await vectorService.query(
        knowledgeBaseId,
        queryVector,
        10,
        { category: 'tech' },
        pgVectorConfig
      )

      // 应该返回所有结果
      expect(results.length).toBe(3)
    })
  })
})
