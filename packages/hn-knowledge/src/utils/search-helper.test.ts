/**
 * filterLowScoreResults / getDefaultMinScore 单元测试
 *
 * 背景缺陷：旧实现按 searchType 返回不同阈值（semantic 0.2 / keyword 0.1 / hybrid 0.15），
 * 其中 hybrid 融合分若为 RRF 排名分（量级 ≈0.016）会被 0.15 阈值全部误杀。
 * 新语义：三种 searchType 统一使用 MIN_RELEVANCE_SCORE（绝对语义分数的统一质量阈值）。
 */
import { describe, it, expect } from 'bun:test'
import { filterLowScoreResults } from './search-helper'
import { MIN_RELEVANCE_SCORE } from '../config/search.constants'

describe('filterLowScoreResults 统一质量阈值', () => {
  const results = [
    { id: 'a', score: 0.9, text: '', metadata: {} },
    { id: 'b', score: MIN_RELEVANCE_SCORE, text: '', metadata: {} },
    { id: 'c', score: MIN_RELEVANCE_SCORE - 0.01, text: '', metadata: {} }
  ] as any[]

  it('三种 searchType 默认阈值一致（统一 MIN_RELEVANCE_SCORE）', () => {
    for (const searchType of ['semantic', 'keyword', 'hybrid'] as const) {
      const kept = filterLowScoreResults(results, undefined, searchType)
      expect(kept.map((r) => r.id)).toEqual(['a', 'b'])
    }
  })

  it('显式 minScore 覆盖默认阈值', () => {
    const kept = filterLowScoreResults(results, 0.5, 'hybrid')
    expect(kept.map((r) => r.id)).toEqual(['a'])
  })

  it('阈值比较为闭区间（>=）', () => {
    const kept = filterLowScoreResults([{ id: 'x', score: 0.3, text: '', metadata: {} } as any], 0.3, 'semantic')
    expect(kept.map((r) => r.id)).toEqual(['x'])
  })
})
