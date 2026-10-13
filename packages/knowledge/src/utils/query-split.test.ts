/**
 * splitQuery 单元测试：疑问框架剥离、定语/连接词切分、保底
 */
import { describe, it, expect } from 'bun:test'
import { splitQuery } from './query-split'

describe('splitQuery 查询分词', () => {
  it('剥离疑问框架，保留核心词', () => {
    const subs = splitQuery('知识库是什么')
    expect(subs).toContain('知识库')
    for (const s of subs) expect(s).not.toMatch(/是什么/)
  })

  it('定语边界切分：harness 平台的知识库是什么 → 含 harness 平台 / 知识库', () => {
    const subs = splitQuery('harness 平台的知识库是什么')
    expect(subs.length).toBeGreaterThanOrEqual(2)
    expect(subs.some((s) => s.includes('知识库'))).toBe(true)
    expect(subs.some((s) => s.includes('harness'))).toBe(true)
  })

  it('连接词切分：知识库和 Agent 是什么关系 → 含知识库 / Agent', () => {
    const subs = splitQuery('知识库和 Agent 是什么关系')
    expect(subs.some((s) => s.includes('知识库'))).toBe(true)
    expect(subs.some((s) => s.toLowerCase().includes('agent'))).toBe(true)
  })

  it('片段组有限且去单字', () => {
    const subs = splitQuery('怎么把飞书写的内容弄进知识库？')
    expect(subs.length).toBeGreaterThanOrEqual(1)
    expect(subs.length).toBeLessThanOrEqual(4)
    for (const s of subs) expect(s.length).toBeGreaterThanOrEqual(2)
  })

  it('纯疑问句保底返回原句', () => {
    const subs = splitQuery('怎么办呢')
    expect(subs.length).toBeGreaterThanOrEqual(1)
    expect(subs[0]!.length).toBeGreaterThanOrEqual(2)
  })
})
