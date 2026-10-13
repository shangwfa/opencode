import { describe, expect, it, mock } from 'bun:test'
import type { Pool } from 'pg'
import { PgRdfQuadStore } from './pg-quad-store.js'

describe('PgRdfQuadStore', () => {
  it('返回 PostgreSQL 查询结果中的 statement 和 source provenance', async () => {
    const release = mock()
    const query = mock().mockResolvedValue({
      rows: [{
        x: 'urn:x',
        statementIds: ['s1', 's2'],
        sourceChunkIds: ['doc#0'],
        sourceRunIds: ['run-1'],
      }],
      rowCount: 1,
    })
    const pool = { connect: mock().mockResolvedValue({ query, release }) } as unknown as Pool
    const store = new PgRdfQuadStore(pool, 'test')

    const result = await store.executePlan({
      variables: ['x'],
      patterns: [{ subject: { variable: 'x' }, predicate: { value: 'urn:p' }, object: { value: 'urn:o' } }],
    })

    expect(result.bindings[0]).toMatchObject({
      statementIds: ['s1', 's2'],
      sourceChunkIds: ['doc#0'],
      sourceRunIds: ['run-1'],
    })
    expect(query).toHaveBeenCalledWith(expect.stringContaining('sourceChunkIds'), ['urn:p', 'urn:o'])
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('拒绝会注入 SQL 标识符的 schema 名称', () => {
    const pool = {} as Pool
    expect(() => new PgRdfQuadStore(pool, 'test; DROP SCHEMA public')).toThrow('非法 PostgreSQL schema 名称')
  })

  it('初始化表和索引，批量写入时使用事务', async () => {
    const query = mock().mockResolvedValue({ rows: [], rowCount: 0 })
    const client = { query, release: mock() }
    const pool = { connect: mock().mockResolvedValue(client) } as unknown as Pool
    const store = new PgRdfQuadStore(pool, 'test')
    await store.init()
    await store.add([{
      id: 's1', subject: { value: 'urn:s', kind: 'iri' }, predicate: { value: 'urn:p', kind: 'iri' },
      object: { value: '1', kind: 'literal', datatype: 'xsd:integer' }, graph: 'urn:g', sourceRunId: 'r1', sourceChunkId: 'c1',
    }])
    expect(query.mock.calls[0][0]).toContain('CREATE SCHEMA IF NOT EXISTS test')
    expect(query.mock.calls.some(([sql]) => sql === 'BEGIN')).toBe(true)
    expect(query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(true)
    expect(query.mock.calls.some(([sql, params]) => sql.includes('INSERT INTO test.rdf_quads') && params[4] === 'literal')).toBe(true)
    expect(client.release).toHaveBeenCalledTimes(2)
  })

  it('match 映射 RDF term 和 source 字段，并支持空结果', async () => {
    const query = mock().mockResolvedValue({ rows: [{ id: 's1', subject: 'urn:s', predicate: 'urn:p', object: 'v', object_kind: 'literal', datatype: 'xsd:string', language: null, graph_name: 'urn:g', source_run_id: 'r1', source_chunk_id: 'c1' }], rowCount: 1 })
    const client = { query, release: mock() }
    const store = new PgRdfQuadStore({ connect: mock().mockResolvedValue(client) } as unknown as Pool, 'test')
    const result = await store.match({ subject: 'urn:s', graph: 'urn:g' })
    expect(result[0]).toMatchObject({ id: 's1', graph: 'urn:g', sourceRunId: 'r1', sourceChunkId: 'c1', object: { kind: 'literal', datatype: 'xsd:string' } })
    expect(query).toHaveBeenCalledWith(expect.stringContaining('subject = $1 AND graph_name = $2'), ['urn:s', 'urn:g'])
    expect(client.release).toHaveBeenCalledTimes(1)
  })

  it('写入失败时回滚并继续释放连接', async () => {
    const query = mock()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('insert failed'))
      .mockResolvedValueOnce(undefined)
    const client = { query, release: mock() }
    const store = new PgRdfQuadStore({ connect: mock().mockResolvedValue(client) } as unknown as Pool, 'test')
    await expect(store.add([{ id: 's1', subject: { value: 's', kind: 'iri' }, predicate: { value: 'p', kind: 'iri' }, object: { value: 'o', kind: 'iri' }, graph: 'g' }])).rejects.toThrow('insert failed')
    expect(query).toHaveBeenLastCalledWith('ROLLBACK')
    expect(client.release).toHaveBeenCalledTimes(1)
  })
})
