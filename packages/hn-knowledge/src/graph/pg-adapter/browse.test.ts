import { describe, expect, mock, test } from 'bun:test'
import type { Pool } from 'pg'
import { GraphBrowseNotFoundError, GraphBrowseRepository } from './browse.js'

describe('bounded browse transaction lifecycle', () => {
  const setup = () => {
    const query = mock(async (_sql: string, _params?: unknown[]) => ({ rows: [] }))
    const release = mock(() => {})
    const pool = { connect: mock(async () => ({ query, release })) } as unknown as Pool
    return { query, release, repository: new GraphBrowseRepository(pool, 'test_browse') }
  }
  test('schema interpolation rejects invalid names', () => {
    expect(() => new GraphBrowseRepository({} as Pool, 'test;DROP SCHEMA knowledge')).toThrow('Invalid')
  })
  test('uses snapshot read-only transaction, timeout and releases after commit', async () => {
    const { repository, query, release } = setup()
    expect((await repository.relationTypes({ knowledgeBaseId: 'kb', limit: 1, offset: 0 })).items).toEqual([])
    const sql = query.mock.calls.map(([text]) => text)
    expect(sql[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    expect(sql[1]).toContain('statement_timeout')
    expect(sql.at(-1)).toBe('COMMIT')
    expect(query.mock.calls[2]![1]).toEqual(['kb', 2, 0])
    expect(release).toHaveBeenCalledTimes(1)
  })
  test('query rejection rolls back and releases', async () => {
    const { repository, query, release } = setup()
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT')) throw new Error('statement timeout')
      return { rows: [] }
    })
    await expect(repository.relationTypes({ knowledgeBaseId: 'kb', limit: 1, offset: 0 })).rejects.toThrow('timeout')
    expect(query.mock.calls.at(-1)![0]).toBe('ROLLBACK')
    expect(release).toHaveBeenCalledTimes(1)
  })
  test('foreign anchor fails before relation query', async () => {
    const { repository, query, release } = setup()
    await expect(repository.relations({ knowledgeBaseId: 'kb', nodeId: '11111111-1111-4111-8111-111111111111',
      direction: 'both', limit: 10, offset: 0 })).rejects.toBeInstanceOf(GraphBrowseNotFoundError)
    expect(query.mock.calls.some(([sql]) => sql.includes('graph_edges'))).toBe(false)
    expect(release).toHaveBeenCalledTimes(1)
  })
})
