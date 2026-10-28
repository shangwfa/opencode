import { describe, expect, it, mock } from 'bun:test'
import { OntologySelector } from './ontology-selector.js'
import type { OntologyConfig } from '../ontology/index.js'

const testOntology: OntologyConfig = {
  name: 'test',
  nodes: [
    { type: 'language', description: '编程语言' },
    { type: 'food', description: '食物菜系' },
    { type: 'animal', description: '动物' },
  ],
  edges: [
    { name: '使用', sourceTypes: ['language'], targetTypes: ['language'], description: '语言间调用' },
    { name: '烹饪', sourceTypes: ['food'], targetTypes: ['food'], description: '食材烹制' },
    { name: '捕食', sourceTypes: ['animal'], targetTypes: ['animal'], description: '动物捕食' },
  ],
}

/** 用语义正交的 3 维向量模拟嵌入：索引 0=语言, 1=食物, 2=动物, 3=查询文本 */
function makeFakeEmbedder(queryTopic: 0 | 1 | 2 | null) {
  const vectors: Record<string, number[]> = {
    '实体类型 language：编程语言': [1, 0, 0],
    '实体类型 food：食物菜系': [0, 1, 0],
    '实体类型 animal：动物': [0, 0, 1],
    '关系 使用：语言间调用（language → language）': [0.9, 0.1, 0],
    '关系 烹饪：食材烹制（food → food）': [0.1, 0.9, 0],
    '关系 捕食：动物捕食（animal → animal）': [0, 0.1, 0.9],
  }
  return mock(async (texts: string[]) =>
    texts.map((t) => {
      if (t in vectors) return vectors[t]
      // 查询文本按主题返回方向向量
      if (queryTopic === null) return [0, 0, 0]
      const v = [0, 0, 0]
      v[queryTopic] = 1
      return v
    })
  )
}

describe('OntologySelector（对标 TrustGraph Ontology RAG 本体子集选择）', () => {
  it('未提供 embedTexts 时退化为全量注入', async () => {
    const selector = new OntologySelector(testOntology)
    const text = await selector.select('随便什么文本')

    expect(text).toContain('language')
    expect(text).toContain('food')
    expect(text).toContain('animal')
    expect(text).toContain('使用')
    expect(text).toContain('烹饪')
    expect(text).toContain('捕食')
  })

  it('语义选择只保留与 chunk 相关的本体子集', async () => {
    const embedTexts = makeFakeEmbedder(1) // chunk 讲食物
    const selector = new OntologySelector(testOntology, { embedTexts, threshold: 0.5 })
    const text = await selector.select('川菜如何烹饪豆腐')

    expect(text).toContain('food')
    expect(text).toContain('烹饪')
    expect(text).not.toContain('捕食')
    expect(text).not.toContain('animal')
  })

  it('选中关系自动带出端点类型依赖闭包', async () => {
    const embedTexts = makeFakeEmbedder(0) // chunk 讲语言
    const selector = new OntologySelector(testOntology, { embedTexts, threshold: 0.5 })
    const text = await selector.select('TypeScript 调用 Python')

    expect(text).toContain('使用') // 关系入选
    expect(text).toContain('language') // 端点类型闭包保留
    expect(text).not.toContain('烹饪')
  })

  it('无相关本体元素时返回空字符串（不注入无关约束）', async () => {
    const embedTexts = makeFakeEmbedder(null) // 零向量：与一切正交
    const selector = new OntologySelector(testOntology, { embedTexts, threshold: 0.5 })
    const text = await selector.select('完全无关的内容')
    expect(text).toBe('')
  })

  it('本体元素嵌入被缓存：第二次 select 只嵌入 chunk', async () => {
    const embedTexts = makeFakeEmbedder(0)
    const selector = new OntologySelector(testOntology, { embedTexts, threshold: 0.3 })

    await selector.select('第一次查询')
    const callsAfterFirst = embedTexts.mock.calls.length
    await selector.select('第二次查询')

    // 第一次：本体 6 元素 + chunk = 2 次调用；第二次：仅 chunk = 1 次调用
    expect(callsAfterFirst).toBe(2)
    expect(embedTexts.mock.calls.length).toBe(3)
    expect(embedTexts.mock.calls[2][0][0]).toBe('第二次查询')
  })

  it('嵌入失败时降级为全量注入', async () => {
    const embedTexts = mock(async () => {
      throw new Error('嵌入服务不可用')
    })
    const selector = new OntologySelector(testOntology, { embedTexts })
    const text = await selector.select('任何文本')

    expect(text).toContain('language')
    expect(text).toContain('捕食')
  })

  it('maxEdges/maxNodes 限制子集规模', async () => {
    const bigOntology: OntologyConfig = {
      name: 'big',
      nodes: Array.from({ length: 10 }, (_, i) => ({ type: `type_${i}`, description: `类型${i}` })),
      edges: [],
    }
    // 全部元素与查询同方向 → 全部超过阈值，靠 maxNodes 截断
    const embedTexts = mock(async (texts: string[]) => texts.map(() => [1, 0]))
    const selector = new OntologySelector(bigOntology, { embedTexts, threshold: 0.5, maxNodes: 3, maxEdges: 2 })
    const text = await selector.select('查询')

    const matched = text.match(/type_\d/g) || []
    expect(new Set(matched).size).toBe(3)
  })
})
