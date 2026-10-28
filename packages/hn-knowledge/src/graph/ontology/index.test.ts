import { describe, expect, it } from 'bun:test'
import { OntologyValidator, DEFAULT_ONTOLOGY, injectOntology, entityNodeId, entityTypeNodeId, ENTITY_TYPE_KB } from './index.js'
import type { CombinedExtraction } from '../types.js'

describe('OntologyValidator', () => {
  const validator = new OntologyValidator(DEFAULT_ONTOLOGY)

  it('支持父类匹配并过滤非法 datatype 属性', () => {
    const typed = new OntologyValidator({
      name: 'test',
      nodes: [
        { type: 'Device' },
        { type: 'Sensor', parentTypes: ['Device'] },
      ],
      edges: [
        { name: 'label', kind: 'datatype', sourceTypes: ['Device'], targetTypes: ['string'] },
        { name: 'observes', kind: 'object', sourceTypes: ['Sensor'], targetTypes: ['Device'] },
      ],
    })
    const result = typed.validate({
      entities: [
        { name: 'A', type: 'Sensor', attributes: [{ name: 'label', value: 'sensor' }, { name: 'bad', value: 'x' }] },
        { name: 'B', type: 'Device' },
      ],
      triplets: [{ source: 'A', relation: 'observes', target: 'B', confidence: 1 }],
    })
    expect(result.filtered.entities[0].attributes).toEqual([{ name: 'label', value: 'sensor' }])
    expect(result.filtered.triplets).toHaveLength(1)
    expect(result.violations.some((v) => v.kind === 'unknown_attribute')).toBe(true)
  })

  it('应通过符合本体的提取结果', () => {
    const extraction: CombinedExtraction = {
      entities: [
        { name: 'Python', type: 'language' },
        { name: '影刀RPA', type: 'product' },
      ],
      triplets: [
        { source: '影刀RPA', relation: '使用', target: 'Python', confidence: 0.9 },
      ],
    }
    const result = validator.validate(extraction)
    expect(result.valid).toBe(true)
    expect(result.filtered.entities).toHaveLength(2)
    expect(result.filtered.triplets).toHaveLength(1)
  })

  it('应过滤未知节点类型', () => {
    const extraction: CombinedExtraction = {
      entities: [
        { name: 'X', type: 'nonexistent_type' },
        { name: 'Python', type: 'language' },
      ],
      triplets: [],
    }
    const result = validator.validate(extraction)
    expect(result.valid).toBe(false)
    expect(result.filtered.entities).toHaveLength(1)
    expect(result.violations[0].kind).toBe('unknown_node_type')
  })

  it('应过滤不允许的关系端类型', () => {
    const extraction: CombinedExtraction = {
      entities: [
        { name: '张三', type: 'person' },
        { name: 'Python', type: 'language' },
      ],
      triplets: [
        { source: '张三', relation: '包含', target: 'Python', confidence: 0.9 },
      ],
    }
    const result = validator.validate(extraction)
    expect(result.filtered.triplets).toHaveLength(0)
    expect(result.violations.some((v) => v.kind === 'relation_not_allowed')).toBe(true)
  })

  it('应过滤未知关系、数据属性关系和缺失实体引用', () => {
    const result = validator.validate({
      entities: [
        { name: '产品', type: 'product' },
        { name: '版本', type: 'term' },
      ],
      triplets: [
        { source: '产品', relation: '不存在', target: '版本', confidence: 1 },
        { source: '产品', relation: '版本为', target: '版本', confidence: 1 },
        { source: '产品', relation: '使用', target: '缺失', confidence: 1 },
      ],
    })
    expect(result.filtered.triplets).toHaveLength(1)
    expect(result.filtered.triplets[0].relation).toBe('版本为')
    expect(result.violations.map((item) => item.kind)).toEqual(['unknown_relation'])
  })

  it('toPromptText 应生成本体摘要', () => {
    const text = validator.toPromptText()
    expect(text).toContain('实体类型')
    expect(text).toContain('使用')
  })

  it('getFunctionalRelations 应返回单值关系', () => {
    expect(validator.getFunctionalRelations()).toContain('版本为')
  })

  it('isTripletAllowed 支持空约束、父类和数据属性拒绝', () => {
    expect(validator.isTripletAllowed('product', '使用', 'language')).toBe(true)
    expect(validator.isTripletAllowed('product', '版本为', 'term')).toBe(true)
    expect(validator.isTripletAllowed('product', '不存在', 'term')).toBe(false)
    expect(validator.isTripletAllowed('product', '版本为', 'language')).toBe(false)
  })

  it('injectOntology 无本体文本时返回原提示', () => {
    const prompt = '提取实体'
    expect(injectOntology(prompt)).toBe(prompt)
    expect(injectOntology(prompt, '')).toBe(prompt)
  })

  it('injectOntology 有本体文本时追加约束', () => {
    const result = injectOntology('提取实体', '允许类型：person')
    expect(result).toContain('提取实体')
    expect(result).toContain('【本体约束】')
    expect(result).toContain('允许类型：person')
  })

  it('entityNodeId 确定性', () => {
    expect(entityNodeId('kb1', '影刀RPA')).toBe(entityNodeId('kb1', '影刀RPA'))
    expect(entityNodeId('kb1', 'Python')).not.toBe(entityNodeId('kb2', 'Python'))
  })

  it('entityTypeNodeId 基于 ENTITY_TYPE_KB', () => {
    expect(entityTypeNodeId('product')).toBe(entityNodeId(ENTITY_TYPE_KB, 'EntityType:product'))
  })
})
