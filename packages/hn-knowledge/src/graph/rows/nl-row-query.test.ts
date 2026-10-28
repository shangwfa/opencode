import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { PgRowStore } from './pg-row-store.js'
import type { RowSchema } from './schema.js'
import type { Pool } from 'pg'

const { generateObjectMock } = ({ generateObjectMock: mock() })

mock.module('ai', () => ({ generateObject: generateObjectMock, embed: mock(), embedMany: mock() }))
mock.module('../../utils/model-resolver.js', () => ({
  resolveModel: mock(() => ({ modelId: 'mock-model' })),
}))

// 在依赖 mock 就绪后再导入被测模块
const { NaturalLanguageRowQuery } = await import('./nl-row-query.js')

const faqSchema: RowSchema = {
  name: 'faq',
  description: '常见问题表',
  fields: [
    { name: 'id', type: 'string', primary: true },
    { name: 'question', type: 'string', vectorIndex: true },
    { name: 'category', type: 'string', queryIndex: true, enumValues: ['产品', '技术'] },
  ],
}

const productSchema: RowSchema = {
  name: 'product',
  description: '产品清单',
  fields: [
    { name: 'code', type: 'string', primary: true },
    { name: 'name', type: 'string', vectorIndex: true },
    { name: 'price', type: 'number', queryIndex: true },
  ],
}

function makeStore(): PgRowStore {
  const query = mock(async (sql: string) => {
    if (sql.includes('SELECT id, schema_name')) {
      return {
        rows: [
          { id: 'faq:1', schema_name: 'faq', data: { id: '1', question: '如何退款' }, source: null, created_at: new Date() },
        ],
        rowCount: 1,
      }
    }
    return { rows: [], rowCount: 0 }
  })
  const connect = mock(async () => ({ query, release: mock() }))
  const pool = { query, connect } as unknown as Pool
  const store = new PgRowStore(pool, 'test')
  store.registerSchema(faqSchema)
  store.registerSchema(productSchema)
  return store
}

describe('NaturalLanguageRowQuery（对标 TrustGraph nlp-query 两阶段编排）', () => {
  let store: PgRowStore

  beforeEach(() => {
    store = makeStore()
    generateObjectMock.mockReset()
  })

  it('两阶段：先选 schema 再生成过滤计划并执行', async () => {
    generateObjectMock
      .mockResolvedValueOnce({ object: { schemas: ['faq'] } }) // Phase 1
      .mockResolvedValueOnce({
        object: {
          filters: [{ field: 'category', op: 'eq', value: '售后' }],
          semanticQuery: '退款流程',
          confidence: 0.85,
        },
      }) // Phase 2

    const nlQuery = new NaturalLanguageRowQuery(store, { embedFn: async (texts) => texts.map(() => [0.1, 0.2]) })
    const result = await nlQuery.query('售后的退款问题怎么处理')

    // Phase 1 只把选中的 schema 详情给 Phase 2
    const phase2Prompt = generateObjectMock.mock.calls[1][0].prompt as string
    expect(phase2Prompt).toContain('常见问题表')
    expect(phase2Prompt).not.toContain('产品清单')

    expect(result.schema.name).toBe('faq')
    expect(result.filters).toEqual([{ field: 'category', op: 'eq', value: '售后' }])
    expect(result.semanticQuery).toBe('退款流程')
    expect(result.confidence).toBe(0.85)
    expect(result.records).toHaveLength(1)
  })

  it('单 schema 时跳过 Phase 1', async () => {
    const single = makeStore()
    // 重注册只留一个
    const store2 = new PgRowStore(single['pool' as never] as Pool, 'test')
    store2.registerSchema(productSchema)

    generateObjectMock.mockResolvedValueOnce({
      object: { filters: [], semanticQuery: '产品', confidence: 0.7 },
    })

    const nlQuery = new NaturalLanguageRowQuery(store2)
    await nlQuery.query('有哪些产品')

    expect(generateObjectMock).toHaveBeenCalledTimes(1) // 只有 Phase 2
  })

  it('Phase 1 失败时退化为全部 schema', async () => {
    generateObjectMock
      .mockRejectedValueOnce(new Error('选择超时'))
      .mockResolvedValueOnce({
        object: { filters: [], semanticQuery: 'q', confidence: 0.5 },
      })

    const nlQuery = new NaturalLanguageRowQuery(store)
    const result = await nlQuery.query('任意问题')

    // Phase 2 prompt 包含全部 schema 详情（退化行为）
    const phase2Prompt = generateObjectMock.mock.calls[1][0].prompt as string
    expect(phase2Prompt).toContain('常见问题表')
    expect(phase2Prompt).toContain('产品清单')
    expect(result.records).toHaveLength(1)
  })

  it('LLM 生成非白名单字段的过滤条件在执行时被剔除', async () => {
    generateObjectMock
      .mockResolvedValueOnce({ object: { schemas: ['faq'] } })
      .mockResolvedValueOnce({
        object: {
          filters: [{ field: 'question', op: 'eq', value: 'x' }], // question 未标 queryIndex
          semanticQuery: null,
          confidence: 0.6,
        },
      })

    const nlQuery = new NaturalLanguageRowQuery(store)
    const result = await nlQuery.query('q')
    // 不抛异常：白名单过滤是 store 层兜底
    expect(result.records).toHaveLength(1)
  })

  it('语义通道：结构化结果不足时用 semanticQuery 叠加检索', async () => {
    generateObjectMock
      .mockResolvedValueOnce({ object: { schemas: ['faq'] } })
      .mockResolvedValueOnce({
        object: { filters: [], semanticQuery: '退款流程', confidence: 0.8 },
      })

    const embedFn = mock(async (texts: string[]) => texts.map(() => [0.1, 0.2]))
    const nlQuery = new NaturalLanguageRowQuery(store, { embedFn })
    const result = await nlQuery.query('退款')

    expect(embedFn).toHaveBeenCalledWith(['退款流程'])
    expect(result.records).toHaveLength(1)
  })
})
