import { describe, expect, it, mock as mockFn } from 'bun:test'
import type { Pool } from 'pg'
import { PgOntologyRegistry } from './pg-registry.js'

const config = { name: 'test', nodes: [], edges: [] }

function poolMock() {
  const queries: Array<{ sql: string; params?: unknown[] }> = []
  const query = mockFn(async (sql: string, params?: unknown[]) => {
    queries.push({ sql, params })
    if (sql.includes('MAX(version)')) return { rows: [{ version: '2' }], rowCount: 1 }
    if (sql.includes('RETURNING *')) return { rows: [{ ontology_id: 'support', version: 2, content_hash: 'hash', status: 'draft', config, created_at: '2026-01-01T00:00:00.000Z', published_at: null }], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  })
  const client = { query, release: mockFn() }
  return { pool: { query, connect: mockFn().mockResolvedValue(client) } as unknown as Pool, queries, client }
}

describe('PgOntologyRegistry', () => {
  it('初始化并创建版本快照', async () => {
    const mock = poolMock()
    const registry = new PgOntologyRegistry(mock.pool, 'test')
    await registry.init()
    const version = await registry.create('support', config)
    expect(version).toMatchObject({ ontologyId: 'support', version: 2, status: 'draft', config })
    expect(mock.queries.some((item) => item.sql.includes('CREATE TABLE IF NOT EXISTS test.ontology_versions'))).toBe(true)
  })

  it('映射 get/getActive，并在发布时使用事务', async () => {
    const mock = poolMock()
    const row = { ontology_id: 'support', version: '1', content_hash: 'hash', status: 'published', config, created_at: '2026-01-01T00:00:00.000Z', published_at: '2026-01-02T00:00:00.000Z' }
    mock.pool = { ...mock.pool, query: mockFn()
      .mockResolvedValueOnce({ rows: [row], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [row], rowCount: 1 }) } as unknown as Pool
    const registry = new PgOntologyRegistry(mock.pool, 'test')
    expect(await registry.get('support', 1)).toMatchObject({ ontologyId: 'support', version: 1, status: 'published', publishedAt: expect.any(String) })
    expect(await registry.getActive('support')).toMatchObject({ ontologyId: 'support' })

    const clientQuery = mockFn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ ...row }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [row], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
    const client = { query: clientQuery, release: mockFn() }
    const pool = { connect: mockFn().mockResolvedValue(client) } as unknown as Pool
    const publishing = new PgOntologyRegistry(pool, 'test')
    await expect(publishing.publish('support', 1)).resolves.toMatchObject({ status: 'published' })
    expect(clientQuery.mock.calls.map(([sql]) => sql)).toEqual(expect.arrayContaining(['BEGIN', 'COMMIT']))
    expect(client.release).toHaveBeenCalledTimes(1)
  })

  it('发布不存在版本时回滚并释放连接', async () => {
    const clientQuery = mockFn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
    const client = { query: clientQuery, release: mockFn() }
    const registry = new PgOntologyRegistry({ connect: mockFn().mockResolvedValue(client) } as unknown as Pool, 'test')
    await expect(registry.publish('missing', 1)).rejects.toThrow('版本不存在')
    expect(clientQuery).toHaveBeenLastCalledWith('ROLLBACK')
    expect(client.release).toHaveBeenCalledTimes(1)
  })

  it('拒绝非法 schema 名称', () => {
    expect(() => new PgOntologyRegistry({} as Pool, 'test; DROP TABLE ontology_versions')).toThrow('非法 PostgreSQL schema 名称')
  })
})
