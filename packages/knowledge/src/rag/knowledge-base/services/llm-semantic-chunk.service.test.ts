/**
 * LLMSemanticChunkService 单元测试
 * 测试LLM语义分块功能
 */

import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test'

/** vi.mocked 的 bun 等价物：仅做类型断言，便于对 mock 函数调用 mock* 方法 */
const mocked = (fn: unknown): any => fn as any
type LLMSemanticChunkService = import('./llm-semantic-chunk.service').LLMSemanticChunkService

// Mock ai 模块 - 内联以避免 hoisting 问题
mock.module('ai', () => ({
  generateText: mock().mockResolvedValue({
    text: JSON.stringify({
      chunks: []
    })
  })
}))

// Mock @ai-sdk/openai
mock.module('@ai-sdk/openai', () => ({
  createOpenAI: mock(() => ({
    chat: mock(),
    embedding: mock(),
  })),
  openai: mock()
}))

// 被测模块：mock 注册后动态导入
const { LLMSemanticChunkService } = await import('./llm-semantic-chunk.service')

describe('LLMSemanticChunkService', () => {
  let service: LLMSemanticChunkService

  beforeEach(() => {
    service = new LLMSemanticChunkService()
    mock.clearAllMocks()
  })

  describe('初始化', () => {
    it('应该成功创建实例', () => {
      expect(service).toBeInstanceOf(LLMSemanticChunkService)
    })
  })

  describe('chunkByLLM - 短文本处理', () => {
    it('应该直接返回短文本', async () => {
      const shortText = 'This is a short text.'
      const result = await service.chunkByLLM(shortText, { maxChunkSize: 1000 })

       expect(result).toHaveLength(1)
      expect(result[0].text).toBe(shortText)
    })

    it('应该处理空文本', async () => {
      const result = await service.chunkByLLM('', { maxChunkSize: 1000 })
      expect(result).toHaveLength(1)
      expect(result[0].text).toBe('')
    })

    it('应该处理刚好等于maxChunkSize的文本', async () => {
      const text = 'a'.repeat(1000)
      const result = await service.chunkByLLM(text, { maxChunkSize: 1000 })

      expect(result).toHaveLength(1)
      expect(result[0].text).toBe(text)
    })
  })

  describe('chunkByLLM - 长文本处理', () => {
    it('应该调用LLM分块长文本', async () => {
      const longText = 'a'.repeat(1500)

      const { generateText } = await import('ai')
      mocked(generateText).mockResolvedValue({
        text: JSON.stringify({
          chunks: [
            {
              text: longText.slice(0, 750),
              startIndex: 0,
              endIndex: 750,
              summary: 'First half'
            },
            {
              text: longText.slice(750),
              startIndex: 750,
              endIndex: 1500,
              summary: 'Second half'
            }
          ],
          reasoning: 'Test reasoning'
        })
      })

      const result = await service.chunkByLLM(longText, {
        maxChunkSize: 1000,
        minChunkSize: 100
      })

      expect(result).toHaveLength(2)
      expect(result[0].metadata.chunkIndex).toBe(0)
      expect(result[1].metadata.chunkIndex).toBe(1)
    })

    it('应该在LLM失败时使用回退策略', async () => {
      const longText = 'a'.repeat(1500)

      const { generateText } = await import('ai')
      mocked(generateText).mockRejectedValue(new Error('API Error'))

      const result = await service.chunkByLLM(longText, {
        maxChunkSize: 1000,
        minChunkSize: 100,
        maxRetries: 1
      })

      // 回退策略应该产生一些结果
      expect(result.length).toBeGreaterThan(0)
    })
  })

  describe('chunkByLLM - 配置选项', () => {
    it('应该使用默认配置', async () => {
      const longText = 'a'.repeat(1500)

      const { generateText } = await import('ai')
      mocked(generateText).mockResolvedValue({
        text: JSON.stringify({
          chunks: [{ text: longText, startIndex: 0, endIndex: 1500 }]
        })
      })

      const result = await service.chunkByLLM(longText)

      expect(result).toHaveLength(2)
    })

    it('应该支持自定义maxChunkSize', async () => {
      const text = 'a'.repeat(500)
      const result = await service.chunkByLLM(text, { maxChunkSize: 1000 })

      expect(result).toHaveLength(1)
    })

    it('应该支持自定义minChunkSize', async () => {
      const text = 'a'.repeat(500)
      const result = await service.chunkByLLM(text, {
        maxChunkSize: 1000,
        minChunkSize: 200
      })

      expect(result).toHaveLength(1)
    })

    it('应该支持自定义maxRetries', async () => {
      const longText = 'a'.repeat(1500)

      const { generateText } = await import('ai')
      mocked(generateText).mockRejectedValue(new Error('API Error'))

      const result = await service.chunkByLLM(longText, {
        maxChunkSize: 1000,
        minChunkSize: 100,
        maxRetries: 2
      })

      expect(generateText).toHaveBeenCalledTimes(2)
      expect(result.length).toBeGreaterThan(0)
    })
  })

  describe('chunkByLLM - 边界情况', () => {
    it('应该处理包含特殊字符的文本', async () => {
      const specialText = '测试\n\n文本'.repeat(100)
      const result = await service.chunkByLLM(specialText, { maxChunkSize: 1000 })

      expect(result).toHaveLength(1)
    })

    it('应该处理Unicode字符', async () => {
      const unicodeText = '你好世界🌍'.repeat(100)
      const result = await service.chunkByLLM(unicodeText, { maxChunkSize: 1000 })

      expect(result).toHaveLength(1)
    })

    it('应该处理非常大的文本', async () => {
      const veryLongText = 'a'.repeat(10000)

      const { generateText } = await import('ai')
      mocked(generateText).mockResolvedValue({
        text: JSON.stringify({
          chunks: [{ text: veryLongText.slice(0, 1000), startIndex: 0, endIndex: 1000 }]
        })
      })

      const result = await service.chunkByLLM(veryLongText, {
        maxChunkSize: 1000,
        minChunkSize: 100
      })

      expect(result.length).toBeGreaterThan(0)
    })
  })

  describe('chunkByLLM - 元数据', () => {
    it('应该包含chunkIndex元数据', async () => {
      const longText = 'a'.repeat(1500)

      const { generateText } = await import('ai')
      mocked(generateText).mockResolvedValue({
        text: JSON.stringify({
          chunks: [
            { text: longText.slice(0, 750), startIndex: 0, endIndex: 750 },
            { text: longText.slice(750), startIndex: 750, endIndex: 1500 }
          ]
        })
      })

      const result = await service.chunkByLLM(longText, {
        maxChunkSize: 1000,
        minChunkSize: 100
      })

      expect(result[0].metadata.chunkIndex).toBe(0)
      expect(result[1].metadata.chunkIndex).toBe(1)
    })

    it('应该包含summary元数据', async () => {
      const longText = 'a'.repeat(1500)

      const { generateText } = await import('ai')
      mocked(generateText).mockResolvedValue({
        text: JSON.stringify({
          chunks: [
            { text: longText, startIndex: 0, endIndex: 1500, summary: 'Test summary' }
          ]
        })
      })

      const result = await service.chunkByLLM(longText, {
        maxChunkSize: 1000,
        minChunkSize: 100
      })

      expect(result[0].metadata.summary).toBe('Test summary')
    })

    it('应该包含startIndex和endIndex元数据', async () => {
      const longText = 'a'.repeat(1500)

      const { generateText } = await import('ai')
      mocked(generateText).mockResolvedValue({
        text: JSON.stringify({
          chunks: [
            { text: longText.slice(0, 750), startIndex: 0, endIndex: 750 }
          ]
        })
      })

      const result = await service.chunkByLLM(longText, {
        maxChunkSize: 1000,
        minChunkSize: 100
      })

      expect(result[0].metadata.startIndex).toBe(0)
      expect(result[0].metadata.endIndex).toBe(750)
    })
  })
})
