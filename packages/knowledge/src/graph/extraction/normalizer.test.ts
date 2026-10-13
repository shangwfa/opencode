import { describe, expect, it } from 'bun:test'
import { normalizeExtraction, normalizeRelationName } from './normalizer.js'

describe('extraction normalizer', () => {
  it('normalizes aliases and merges duplicate entities/triplets', () => {
    const result = normalizeExtraction({
      entities: [
        { name: '  影刀RPA ', type: 'product', description: 'RPA' },
        { name: '影刀RPA', type: 'product', description: '一款桌面自动化产品' },
        { name: 'Excel处理', type: 'feature' },
      ],
      triplets: [
        { source: '影刀RPA', relation: '核心功能', target: 'Excel处理', confidence: 0.7 },
        { source: '影刀RPA', relation: '包含', target: 'Excel处理', confidence: 0.9 },
      ],
    })

    expect(result.entities).toHaveLength(2)
    expect(result.entities[0].description).toBe('一款桌面自动化产品')
    expect(result.triplets).toEqual([
      { source: '影刀RPA', relation: '包含', target: 'Excel处理', confidence: 0.9 },
    ])
  })

  it('keeps unknown relations while normalizing known aliases', () => {
    expect(normalizeRelationName('最新版本为')).toBe('版本为')
    expect(normalizeRelationName('调用')).toBe('调用')
  })
})
