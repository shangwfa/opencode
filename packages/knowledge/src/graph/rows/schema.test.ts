import { describe, expect, it } from 'bun:test'
import type { RowSchema, RowData } from './schema.js'
import { rowToText, validateRow, getRowSchemaText } from './schema.js'

const faqSchema: RowSchema = {
  name: 'faq',
  description: '常见问题表',
  fields: [
    { name: 'id', type: 'string', primary: true },
    { name: 'question', type: 'string', required: true, vectorIndex: true, description: '问题' },
    { name: 'answer', type: 'string', vectorIndex: true, description: '答案' },
    { name: 'category', type: 'string', queryIndex: true, enumValues: ['产品', '技术', '售后'] },
    { name: 'priority', type: 'number', queryIndex: true },
  ],
}

describe('rowToText', () => {
  it('优先拼接 vectorIndex 字段', () => {
    const row: RowData = { id: '1', question: '如何退款', answer: '7天无理由', category: '售后', priority: 1 }
    expect(rowToText(faqSchema, row)).toBe('如何退款；7天无理由')
  })

  it('无 vectorIndex 字段时使用全部字段', () => {
    const schema: RowSchema = { name: 's', fields: [{ name: 'a', type: 'string' }, { name: 'b', type: 'number' }] }
    expect(rowToText(schema, { a: 'x', b: 2 })).toBe('x；2')
  })

  it('空值字段跳过', () => {
    expect(rowToText(faqSchema, { id: '1', question: 'q', answer: null, category: '产品' })).toBe('q')
  })
})

describe('validateRow', () => {
  it('required 缺失报违规', () => {
    const violations = validateRow(faqSchema, { id: '1', answer: 'a', category: '产品', priority: 1 })
    expect(violations.some((v) => v.includes('question'))).toBe(true)
  })

  it('枚举外值报违规', () => {
    const violations = validateRow(faqSchema, { id: '1', question: 'q', category: '不存在' })
    expect(violations.some((v) => v.includes('枚举'))).toBe(true)
  })

  it('类型不符报违规', () => {
    const violations = validateRow(faqSchema, { id: '1', question: 'q', category: '产品', priority: '高' })
    expect(violations.some((v) => v.includes('数字'))).toBe(true)
  })

  it('合法行无违规', () => {
    expect(validateRow(faqSchema, { id: '1', question: 'q', category: '产品', priority: 3 })).toEqual([])
  })
})

describe('getRowSchemaText', () => {
  it('概览模式只含名称与描述', () => {
    const text = getRowSchemaText(faqSchema)
    expect(text).toContain('faq')
    expect(text).toContain('常见问题表')
    expect(text).not.toContain('可过滤')
  })

  it('详细模式含字段与索引标注', () => {
    const text = getRowSchemaText(faqSchema, true)
    expect(text).toContain('可过滤')
    expect(text).toContain('语义检索')
    expect(text).toContain('枚举: 产品/技术/售后')
  })
})
