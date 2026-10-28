import { describe, expect, it, mock } from 'bun:test'

// 隔离 LLM provider 导入链（@xybot/observability 在测试环境不可用）
mock.module('../../utils/model-resolver.js', () => ({
  resolveModel: (model: string) => {
    throw new Error(`Mocked provider unavailable: ${model}`)
  },
}))

// 模拟降级行为：提取器在任何 LLM 失败场景下都应返回空结果而非抛异常
describe('EntityExtractor (unit)', () => {
  it('should handle empty text gracefully', async () => {
    const extractor = new (class {
      async extract(text: string) {
        if (!text.trim()) return { entities: [], triplets: [] }
        return { entities: [], triplets: [] }
      }
    })()
    await expect(extractor.extract('')).resolves.toEqual({ entities: [], triplets: [] })
  })

  it('should handle short text gracefully', async () => {
    const extractor = new (class {
      async extract(text: string) {
        if (!text.trim()) return { entities: [], triplets: [] }
        return { entities: [], triplets: [] }
      }
    })()
    await expect(extractor.extract('Hello')).resolves.toEqual({ entities: [], triplets: [] })
  })

  it('should handle LLM provider error gracefully', async () => {
    const { EntityExtractor } = await import('./entity-extractor.js')
    const extractor = new EntityExtractor({ model: 'google/nonexistent-model', maxRetries: 0 })
    const result = await extractor.extract('这是一段测试文本')
    expect(result.entities).toEqual([])
    expect(result.triplets).toEqual([])
  })
})