import { describe, expect, it } from 'bun:test'
import { buildCompilationPlan } from '../../services/wiki-compilation-plan.js'

const a = { id: 'a', content: 'A 新事实', type: 'markdown', knowledgeBaseId: 'kb' }
const b = { id: 'b', content: 'B 独立事实', type: 'markdown', knowledgeBaseId: 'kb' }
const concept = { id: 'c', conceptName: '知识库', slug: '知识库', content: { sections: [{ heading: '旧页', content: 'A 旧事实和 B 独立事实' }] } }
const sources = [
  { conceptId: 'c', documentId: 'a', contentHash: 'old-a' },
  { conceptId: 'c', documentId: 'b', contentHash: 'old-b' },
]
const extracted = { concept: '知识库', summary: '新摘要', tags: [], aliases: [], is_new: false, related_concepts: [] }

describe('Wiki 编译来源计划', () => {
  it('只更新 A 时仍收集 B，并保留已有页面供对照', () => {
    const plan = buildCompilationPlan([a, b], [concept], sources, new Map([['a', [extracted]]]), true)
    expect(plan).toHaveLength(1)
    expect(plan[0].sources.map(s => s.document.id).sort()).toEqual(['a', 'b'])
    expect(plan[0].previous).toEqual(concept)
    expect(plan[0].sources.find(s => s.document.id === 'b')?.contentHash).toBe('old-b')
  })
  it('A 不再包含概念时撤销 A 来源，但保留 B', () => {
    const plan = buildCompilationPlan([a, b], [concept], sources, new Map([['a', []]]), true)
    expect(plan[0].sources.map(s => s.document.id)).toEqual(['b'])
  })
  it('最后一篇来源撤销后产生零来源失效计划', () => {
    const plan = buildCompilationPlan([a], [concept], sources.slice(0, 1), new Map([['a', []]]), true)
    expect(plan[0].sources).toEqual([])
  })
  it('全库编译发现已删除文档并更新受影响概念', () => {
    const plan = buildCompilationPlan([b], [concept], sources, new Map(), true)
    expect(plan[0].sources.map(s => s.document.id)).toEqual(['b'])
  })
  it('同一文档重复提取不增加来源数，同 slug 合并', () => {
    const plan = buildCompilationPlan([a, b], [concept], sources, new Map([['a', [extracted, extracted]]]), true)
    expect(plan).toHaveLength(1)
    expect(plan[0].sources).toHaveLength(2)
  })
  it('未变化、未删除的概念无需重编', () => {
    expect(buildCompilationPlan([a, b], [concept], sources, new Map(), true)).toEqual([])
  })

  it('重编保留已有别名并合并本轮别名', () => {
    const previous = { ...concept, tags: ['alias:KB', '旧业务标签'] }
    const plan = buildCompilationPlan([a, b], [previous], sources,
      new Map([['a', [{ ...extracted, aliases: ['Knowledge Base', 'KB'] }]]]), true)
    expect(plan[0].aliasTags.sort()).toEqual(['alias:KB', 'alias:Knowledge Base'])
  })
})
