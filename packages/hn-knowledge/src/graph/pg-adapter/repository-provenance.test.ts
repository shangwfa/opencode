import { beforeEach, describe, expect, it, mock as mockFn } from 'bun:test'
import { GraphRepository } from './repository.js'
import type { Pool } from 'pg'

/**
 * repository 溯源新逻辑单测（mock pool，不依赖真实 PG）：
 * - graph_document_nodes 的 page_index 列（建表 + 既有表迁移）
 * - linkNodesToDocument 的 pageIndex 透传
 * - getProvenanceLinks 审计链数据源
 *
 * 含 embedding/ANN 的完整行为由集成测试（test:graph:local）覆盖。
 */
function mockPool() {
  const queries: Array<{ sql: string; params: unknown[] }> = []
  const query = mockFn(async (sql: string, params?: unknown[]) => {
    queries.push({ sql, params: params || [] })
    return { rows: [], rowCount: 0 }
  })
  const connect = mockFn(async () => ({ query, release: mockFn() }))
  return { pool: { query, connect } as unknown as Pool, queries }
}

describe('GraphRepository 溯源链新逻辑（page_index + getProvenanceLinks）', () => {
  let mock: ReturnType<typeof mockPool>
  let repo: GraphRepository

  beforeEach(() => {
    mock = mockPool()
    repo = new GraphRepository(mock.pool, 'test')
  })

  it('init 建表含 page_index 列', async () => {
    await repo.initTables()
    const createSql = mock.queries.map((q) => q.sql).find((s) => s.includes('graph_document_nodes'))
    expect(createSql).toBeDefined()
    expect(createSql).toContain('page_index INTEGER')
  })

  it('init 对既有表自动迁移 page_index（information_schema 探测后 ALTER）', async () => {
    const query = mockFn(async (sql: string, params?: unknown[]) => {
      mock.queries.push({ sql, params: params || [] })
      // 模拟既有表：page_index 已存在检查返回 0 行 → 触发 ALTER
      if (sql.includes('information_schema.columns') && sql.includes('page_index')) {
        return { rows: [], rowCount: 0 }
      }
      return { rows: [], rowCount: 0 }
    })
    const connect = mockFn(async () => ({ query, release: mockFn() }))
    const legacyRepo = new GraphRepository({ query, connect } as unknown as Pool, 'legacy')

    await legacyRepo.initTables()

    const alter = mock.queries.find(
      (q) => q.sql.includes('ALTER TABLE') && q.sql.includes('ADD COLUMN page_index')
    )
    expect(alter).toBeDefined()
    expect(alter!.sql).toContain('legacy.graph_document_nodes')
  })

  it('init 既有表已有 page_index 时不重复 ALTER', async () => {
    const query = mockFn(async (sql: string, params?: unknown[]) => {
      mock.queries.push({ sql, params: params || [] })
      if (sql.includes('information_schema.columns') && sql.includes('page_index')) {
        return { rows: [{ column_name: 'page_index' }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    })
    const connect = mockFn(async () => ({ query, release: mockFn() }))
    const modernRepo = new GraphRepository({ query, connect } as unknown as Pool, 'modern')

    await modernRepo.initTables()

    expect(
      mock.queries.some((q) => q.sql.includes('ADD COLUMN page_index'))
    ).toBe(false)
  })

  it('linkNodesToDocument 写入 page_index 且参数顺序正确', async () => {
    await repo.linkNodesToDocument({
      documentId: 'doc_1',
      nodeIds: ['n1', 'n2'],
      chunkIndex: 3,
      pageIndex: 7,
      pipelineRunId: 'run_9',
    })

    const insert = mock.queries.find((q) => q.sql.includes('INSERT INTO') && q.sql.includes('graph_document_nodes'))
    expect(insert).toBeDefined()
    expect(insert!.sql).toContain('page_index')
    // [documentId, nodeId, chunkIndex, pageIndex, pipelineRunId]
    expect(insert!.params).toEqual(['doc_1', 'n1', 3, 7, 'run_9'])
    // 两个节点各一条 INSERT
    expect(mock.queries.filter((q) => q.sql.includes('INSERT INTO') && q.sql.includes('graph_document_nodes'))).toHaveLength(2)
  })

  it('linkNodesToDocument 缺省 page_index 时写 null', async () => {
    await repo.linkNodesToDocument({ documentId: 'doc_1', nodeIds: ['n1'] })

    const insert = mock.queries.find((q) => q.sql.includes('INSERT INTO'))
    expect(insert!.params[3]).toBeNull()
  })

  it('getProvenanceLinks 映射 snake_case → camelCase（含 null 保留）', async () => {
    const query = mockFn(async (sql: string, params?: unknown[]) => {
      mock.queries.push({ sql, params: params || [] })
      if (sql.includes('SELECT node_id, document_id, chunk_index, page_index')) {
        return {
          rows: [
            { node_id: 'n1', document_id: 'doc_42', chunk_index: 3, page_index: 7, pipeline_run_id: 'run1' },
            { node_id: 'n2', document_id: 'doc_7', chunk_index: null, page_index: null, pipeline_run_id: null },
          ],
          rowCount: 2,
        }
      }
      return { rows: [], rowCount: 0 }
    })
    const connect = mockFn(async () => ({ query, release: mockFn() }))
    const provenanceRepo = new GraphRepository({ query, connect } as unknown as Pool, 'test')

    const links = await provenanceRepo.getProvenanceLinks(['n1', 'n2'])

    expect(links).toHaveLength(2)
    expect(links[0]).toEqual({
      nodeId: 'n1',
      documentId: 'doc_42',
      chunkIndex: 3,
      pageIndex: 7,
      pipelineRunId: 'run1',
    })
    expect(links[1]).toEqual({
      nodeId: 'n2',
      documentId: 'doc_7',
      chunkIndex: null,
      pageIndex: null,
      pipelineRunId: null,
    })
    // IN 占位符与参数对齐
    const select = mock.queries.find((q) => q.sql.includes('SELECT node_id, document_id'))
    expect(select!.sql).toContain('WHERE node_id IN ($1,$2)')
    expect(select!.params).toEqual(['n1', 'n2'])
  })

  it('getProvenanceLinks 空入参直接短路', async () => {
    const links = await repo.getProvenanceLinks([])
    expect(links).toEqual([])
    expect(mock.queries.filter((q) => q.sql.includes('SELECT node_id, document_id'))).toHaveLength(0)
  })
})
