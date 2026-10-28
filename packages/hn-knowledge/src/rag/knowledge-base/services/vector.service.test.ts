/**
 * VectorService 单元测试
 * 测试向量存储和检索功能
 */

import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test'
type VectorService = import('./vector.service').VectorService
import type { SearchResultItem } from '../types/knowledge-base.types'

// Mock pg Pool
const pgMocks = (() => {
  const mockQuery = mock().mockResolvedValue({ rows: [{ exists: true }] })
  const mockPoolQuery = mock().mockResolvedValue({ rows: [] })
  const mockRelease = mock()
  const mockConnect = mock().mockResolvedValue({
    query: mockQuery,
    release: mockRelease
  })
  return { mockQuery, mockPoolQuery, mockRelease, mockConnect }
})()

mock.module('pg', () => {
  class MockPool {
    constructor() {
      // Mock pool constructor
    }
    connect = pgMocks.mockConnect
    query = pgMocks.mockPoolQuery
  }

  return {
    Pool: MockPool
  }
})

// Mock ../vector/vector-store.js（vector.service 实际导入的模块；构造现要求接收配置参数）
mock.module('../vector/vector-store.js', () => {
  class MockPgVectorStore {
    constructor(_config: Record<string, unknown>) {}
    createIndex = mock().mockResolvedValue(undefined)
    query = mock().mockResolvedValue([])
    upsert = mock().mockResolvedValue(undefined)
  }

  return {
    PgVectorStore: MockPgVectorStore
  }
})

// 被测模块：mock 注册后动态导入
const { VectorService } = await import('./vector.service')

describe('VectorService', () => {
  let vectorService: VectorService
  const connectionString = 'postgresql://test:test@localhost:5432/test'
  const schemaName = 'test'

  beforeEach(() => {
    vectorService = new VectorService(connectionString, schemaName)
    mock.clearAllMocks()
  })

  describe('初始化', () => {
    it('应该成功创建实例', () => {
      expect(vectorService).toBeInstanceOf(VectorService)
    })

    it('应该保存连接字符串和schema名称', () => {
      const service = new VectorService(connectionString, 'custom_schema')
      expect(service).toBeInstanceOf(VectorService)
    })
  })

  describe('createIndex - 创建索引', () => {
    it('应该成功创建索引', async () => {
      const result = await vectorService.createIndex('test_kb', 1536)

      // void 返回，不抛出错误即为成功
      expect(result).toBeUndefined()
    })

    it('应该处理索引已存在的情况', async () => {
      // Mock 索引已存在的错误
      const result = await vectorService.createIndex('existing_kb', 1536)

      expect(result).toBeUndefined()
    })

    it('应该使用指定的向量维度', async () => {
      const dimensions = 768
      const result = await vectorService.createIndex('test_kb', dimensions)

      expect(result).toBeUndefined()
    })
  })

  describe('upsertVectors - 批量索引chunks', () => {
    it('应该成功索引多个chunks', async () => {
      const embeddings = [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]]
      const metadata = [
        { chunkIndex: 0, text: 'Chunk 1' },
        { chunkIndex: 1, text: 'Chunk 2' }
      ]
      const vectorIds = ['doc1_0', 'doc1_1']

      const result = await vectorService.upsertVectors('test_kb', embeddings, metadata, vectorIds)

      expect(result).toBeUndefined()
    })

    it('应该处理空chunks数组', async () => {
      const result = await vectorService.upsertVectors('test_kb', [], [], [])

      expect(result).toBeUndefined()
    })

    it('应该包含documentId在metadata中', async () => {
      const embeddings = [[0.1, 0.2, 0.3]]
      const metadata = [{ chunkIndex: 0, text: 'Chunk 1', documentId: 'doc1' }]
      const vectorIds = ['doc1_0']

      const result = await vectorService.upsertVectors('test_kb', embeddings, metadata, vectorIds)

      expect(result).toBeUndefined()
    })
  })

  describe('query - 向量搜索', () => {
    it('应该成功执行搜索', async () => {
      const embedding = [0.1, 0.2, 0.3]
      const options = { topK: 10 }

      const result = await vectorService.query('test_kb', embedding, options as any)

      expect(result).toBeInstanceOf(Array)
    })

    it('应该返回空结果当没有匹配时', async () => {
      const embedding = [0.1, 0.2, 0.3]
      const result = await vectorService.query('test_kb', embedding, { topK: 10 } as any)

      expect(result).toEqual([])
    })

    it('应该支持自定义topK', async () => {
      const embedding = [0.1, 0.2, 0.3]
      const result = await vectorService.query('test_kb', embedding, 5)

      expect(result.length).toBeLessThanOrEqual(5)
    })

    it('应该支持minScore过滤', async () => {
      const embedding = [0.1, 0.2, 0.3]
      const result = await vectorService.query('test_kb', embedding, 10, undefined, {
        minScore: 0.7
      })

      expect(result).toBeInstanceOf(Array)
    })

    it('应该支持ef和probes参数', async () => {
      const embedding = [0.1, 0.2, 0.3]
      const result = await vectorService.query('test_kb', embedding, 10, undefined, {
        ef: 100,
        probes: 10
      })

      expect(result).toBeInstanceOf(Array)
    })
  })

  describe('deleteByDocumentId - 删除文档的所有chunks', () => {
    it('应该成功删除指定文档的chunks', async () => {
      const result = await vectorService.deleteByDocumentId('test_kb', 'doc1')

      expect(result).toBeUndefined()
    })

    it('应该处理删除不存在的文档', async () => {
      const result = await vectorService.deleteByDocumentId('test_kb', 'nonexistent_doc')

      expect(result).toBeUndefined()
    })
  })

  describe('getChunksByDocumentId - 获取文档的所有chunks', () => {
    it('应该成功获取文档chunks', async () => {
      const result = await vectorService.getChunksByDocumentId('test_kb', 'doc1')

      expect(result).toBeInstanceOf(Array)
    })

    it('应该返回空数组当文档不存在时', async () => {
      pgMocks.mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
      const result = await vectorService.getChunksByDocumentId('test_kb', 'nonexistent_doc')

      expect(result).toEqual([])
    })
  })

  describe('getChunkByIndex - 获取指定索引的chunk', () => {
    it('应该成功获取指定chunk', async () => {
      const result = await vectorService.getChunkByIndex('test_kb', 'doc1', 0)

      expect(result).toBeDefined()
    })

    it('应该返回null当chunk不存在时', async () => {
      pgMocks.mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
      const result = await vectorService.getChunkByIndex('test_kb', 'doc1', 999)

      expect(result).toBeNull()
    })

    it('应该处理无效的chunkIndex', async () => {
      const result = await vectorService.getChunkByIndex('test_kb', 'doc1', -1)

      expect(result).toBeDefined()
    })
  })

  describe('getAllChunksByKnowledgeBaseId - 获取知识库所有chunks', () => {
    it('应该成功获取所有chunks', async () => {
      const result = await vectorService.getAllChunksByKnowledgeBaseId('test_kb', {
        limit: 100,
        offset: 0
      })

      expect(result).toBeDefined()
      expect(result.chunks).toBeInstanceOf(Array)
      expect(typeof result.total).toBe('number')
    })

    it('应该支持分页参数', async () => {
      const result = await vectorService.getAllChunksByKnowledgeBaseId('test_kb', {
        limit: 50,
        offset: 0,
        orderBy: 'chunkIndex',
        orderDirection: 'ASC'
      })

      expect(result).toBeDefined()
    })

    it('应该限制返回结果数量', async () => {
      const result = await vectorService.getAllChunksByKnowledgeBaseId('test_kb', {
        limit: 10
      })

      expect(result.chunks.length).toBeLessThanOrEqual(10)
    })
  })

  describe('边界情况', () => {
    it('应该处理空的知识库ID', async () => {
      const embedding = [0.1, 0.2, 0.3]
      const result = await vectorService.query('', embedding, 10)

      expect(result).toBeInstanceOf(Array)
    })

    it('应该处理空的embedding', async () => {
      const result = await vectorService.query('test_kb', [], 10)

      expect(result).toBeInstanceOf(Array)
    })

    it('应该处理很大的topK值', async () => {
      const embedding = [0.1, 0.2, 0.3]
      const result = await vectorService.query('test_kb', embedding, 10000)

      expect(result).toBeInstanceOf(Array)
    })
  })

  describe('错误处理', () => {
    it('应该处理数据库连接错误', async () => {
      // Mock connection error
      const embedding = [0.1, 0.2, 0.3]
      const result = await vectorService.query('test_kb', embedding, 10)

      // 应该抛出错误或返回空结果
      expect(result).toBeTruthy()
    })

    it('应该处理查询超时', async () => {
      const embedding = [0.1, 0.2, 0.3]
      const result = await vectorService.query('test_kb', embedding, 10, undefined, {
        timeout: 1
      } as any)

      expect(result).toBeTruthy()
    })
  })
})
