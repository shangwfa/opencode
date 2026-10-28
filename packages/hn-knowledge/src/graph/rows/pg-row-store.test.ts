import { beforeEach, describe, expect, it, mock as mockFn } from 'bun:test'
import { PgRowStore } from './pg-row-store.js'
import { RowRetriever } from './row-retriever.js'
import type { RowSchema } from './schema.js'
import type { Pool } from 'pg'

const faqSchema: RowSchema = {
  name: 'faq',
  fields: [
    { name: 'id', type: 'string', primary: true },
    { name: 'question', type: 'string', required: true, vectorIndex: true },
    { name: 'category', type: 'string', queryIndex: true, enumValues: ['产品', '技术'] },
    { name: 'priority', type: 'number', queryIndex: true },
  ],
}

/** 捕获 SQL 与参数的 mock Pool */
function mockPool() {
  const queries: Array<{ sql: string; params: unknown[] }> = []
  const query = mockFn(async (sql: string, params?: unknown[]) => {
    queries.push({ sql, params: params || [] })
    return { rows: [], rowCount: 0 }
  })
  const connect = mockFn(async () => ({
    query,
    release: mockFn(),
  }))
  return { pool: { query, connect } as unknown as Pool, queries, query, connect }
}

describe('PgRowStore（对标 TrustGraph rows-write + rows-query）', () => {
  let store: PgRowStore
  let mock: ReturnType<typeof mockPool>

  beforeEach(async () => {
    mock = mockPool()
    store = new PgRowStore(mock.pool, 'test')
    // init 由 mock 响应空结果，vectorAvailable=true
    await store.init()
    mock.queries.length = 0
  })

  it('init 建表 + GIN 索引 + 向量列', async () => {
    const fresh = mockPool()
    const freshStore = new PgRowStore(fresh.pool, 'test')
    await freshStore.init()
    const sqls = fresh.queries.map((q) => q.sql).join('\n')
    expect(sqls).toContain('CREATE TABLE IF NOT EXISTS')
    expect(sqls).toContain('USING GIN')
    expect(sqls).toContain('ivfflat')
    expect(sqls).toContain('CREATE EXTENSION IF NOT EXISTS vector')
  })

  it('upsertRows：嵌入 + 参数化写入', async () => {
    const embedFn = mockFn(async (texts: string[]) => texts.map(() => [0.1, 0.2]))
    const ids = await store.upsertRows(
      faqSchema,
      [{ id: 'f1', question: '如何退款', category: '产品', priority: 1 }],
      { embedFn, source: 'faq.csv' }
    )

    expect(ids).toEqual(['faq:f1'])
    expect(embedFn).toHaveBeenCalledTimes(1)
    expect(embedFn.mock.calls[0][0][0]).toBe('如何退款')

    const insert = mock.queries.find((q) => q.sql.includes('INSERT INTO'))
    expect(insert).toBeDefined()
    expect(insert!.params[1]).toBe('faq')
    expect(insert!.params[3]).toBe('faq.csv')
    expect(insert!.sql).toContain('$5::vector')
  })

  it('校验失败的行被跳过', async () => {
    const embedFn = mockFn(async (texts: string[]) => texts.map(() => [0.1, 0.2]))
    const ids = await store.upsertRows(faqSchema, [
      { id: 'f1', question: 'q', category: '产品', priority: 1 }, // 合法
      { id: 'f2', question: null, category: '产品', priority: 1 }, // question 必填缺失
      { id: 'f3', question: 'q', category: '不存在', priority: 1 }, // 枚举外
    ], { embedFn })

    expect(ids).toEqual(['faq:f1'])
    expect(embedFn).toHaveBeenCalledTimes(1) // 只对合法行嵌入
  })

  it('queryRows：过滤字段白名单 + 参数化', async () => {
    await store.queryRows(faqSchema, [
      { field: 'category', op: 'eq', value: '产品' },
      { field: 'priority', op: 'gte', value: 3 },
    ], { limit: 10 })

    const select = mock.queries.find((q) => q.sql.includes('SELECT'))
    expect(select).toBeDefined()
    expect(select!.sql).toContain("data->>'category' = $2")
    expect(select!.sql).toContain("(data->>'priority')::numeric >= $3")
    expect(select!.params[0]).toBe('faq')
    expect(select!.params[1]).toBe('产品')
    expect(select!.params[2]).toBe('3')
  })

  it('非白名单字段被跳过（防注入面）', async () => {
    await store.queryRows(faqSchema, [
      { field: 'question', op: 'eq', value: 'x' }, // question 未标 queryIndex
      { field: "evil'; DROP TABLE rows; --", op: 'eq', value: 'x' },
    ])

    const select = mock.queries.find((q) => q.sql.includes('SELECT'))
    expect(select!.sql).not.toContain('evil')
    expect(select!.sql).not.toContain("data->>'question'")
  })

  it('语义检索：ANN 排序 + score 映射', async () => {
    // 自建 pool：实现内按 SQL 分支返回（mock 的 once/implementation 机制会绕过 push 记录）
    const semanticQueries: Array<{ sql: string; params: unknown[] }> = []
    const query = mockFn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('embedding <=>')) {
        semanticQueries.push({ sql, params: params || [] })
        return {
          rows: [
            { id: 'faq:f1', schema_name: 'faq', data: { id: 'f1', question: 'q' }, source: null, created_at: new Date(), score: 0.92 },
          ],
          rowCount: 1,
        }
      }
      return { rows: [], rowCount: 0 }
    })
    const connect = mockFn(async () => ({ query, release: mockFn() }))
    const semanticStore = new PgRowStore({ query, connect } as unknown as Pool, 'test')
    await semanticStore.init()

    const retriever = new RowRetriever(semanticStore)
    const results = await retriever.search(faqSchema, [0.1, 0.2], { topK: 3 })

    expect(results).toHaveLength(1)
    expect(results[0].score).toBeCloseTo(0.92)
    expect(results[0].record.data.question).toBe('q')

    expect(semanticQueries).toHaveLength(1)
    expect(semanticQueries[0].sql).toContain('1 - (embedding <=>')
    expect(semanticQueries[0].sql).toContain('ORDER BY embedding <=> $2::vector')
    expect(semanticQueries[0].params[0]).toBe('faq')
  })

  it('contains 走 ILIKE，in 展开参数', async () => {
    await store.queryRows(faqSchema, [
      { field: 'category', op: 'contains', value: '产' },
      { field: 'category', op: 'in', value: ['产品', '技术'] },
    ])

    const select = mock.queries.find((q) => q.sql.includes('SELECT'))
    expect(select!.sql).toContain('ILIKE')
    expect(select!.sql).toContain('IN ($3, $4)')
    expect(select!.params).toContain('产品')
    expect(select!.params).toContain('技术')
  })

  it('schema 注册表：registerSchema/listSchemas', () => {
    store.registerSchema(faqSchema)
    expect(store.listSchemas().map((s) => s.name)).toContain('faq')
    expect(store.getSchema('faq')?.name).toBe('faq')
  })
})
