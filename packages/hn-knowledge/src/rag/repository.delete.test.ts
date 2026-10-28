import { beforeEach, describe, expect, it, mock } from 'bun:test'

const dbMocks = {
  connect: mock()
}

mock.module('../db/index.js', () => ({
  pool: {
    connect: dbMocks.connect
  },
  schemaName: 'test_yddoc'
}))

const { BaseKnowledgeRepository } = await import('./repository.js')

function databaseClient(remainingDocumentCount: number, deletedDocumentCount = 1) {
  const query = mock(async (statement: string) => {
    const sql = String(statement)

    if (sql.includes('FROM "test_yddoc".base_knowledge_spaces') && sql.includes('FOR UPDATE')) {
      return {
        rowCount: 1,
        rows: [
          {
            knowledge_base_id: 'kb-001',
            embedding_model: 'openai/text-embedding-3-small',
            embedding_dimension: 1536,
            index_name: 'bk_test'
          }
        ]
      }
    }
    if (sql.includes('DELETE FROM "test_yddoc".base_knowledge\n')) {
      return {
        rowCount: deletedDocumentCount,
        rows: deletedDocumentCount > 0 ? [{ document_id: 'doc-001' }] : []
      }
    }
    if (
      sql.includes('SELECT 1') &&
      sql.includes('FROM "test_yddoc".base_knowledge') &&
      sql.includes('LIMIT 1')
    ) {
      return { rowCount: remainingDocumentCount > 0 ? 1 : 0, rows: [] }
    }

    return { rowCount: 1, rows: [] }
  })

  return {
    query,
    release: mock()
  }
}

describe('BaseKnowledgeRepository.deleteDocument', () => {
  beforeEach(() => {
    mock.clearAllMocks()
  })

  it('drops the vector table and space after deleting the last document', async () => {
    const client = databaseClient(0)
    dbMocks.connect.mockResolvedValue(client)
    const repository = new BaseKnowledgeRepository()
    // 本测试只验证删除事务；初始化建表逻辑由其他入口负责，不应混入 SQL 断言。
    ;(repository as any).initializationPromise = Promise.resolve()

    await repository.deleteDocument('kb-001', 'doc-001')

    const statements = client.query.mock.calls.map(([sql]) => String(sql))
    expect(statements.some((sql) => sql.includes('pg_advisory_xact_lock('))).toBe(true)
    expect(statements.some((sql) => sql.includes('DROP TABLE IF EXISTS "test_yddoc"."bk_test"'))).toBe(
      true
    )
    expect(
      statements.some((sql) => sql.includes('DELETE FROM "test_yddoc".base_knowledge_spaces'))
    ).toBe(true)
  })

  it('keeps the shared vector table while other documents remain', async () => {
    const client = databaseClient(1)
    dbMocks.connect.mockResolvedValue(client)
    const repository = new BaseKnowledgeRepository()
    ;(repository as any).initializationPromise = Promise.resolve()

    await repository.deleteDocument('kb-001', 'doc-001')

    const statements = client.query.mock.calls.map(([sql]) => String(sql))
    expect(statements.some((sql) => sql.includes('DROP TABLE'))).toBe(false)
    expect(statements.some((sql) => sql.includes('DELETE FROM "test_yddoc".base_knowledge_spaces'))).toBe(
      false
    )
  })

  it('cleans an orphaned empty space when the document was already deleted', async () => {
    const client = databaseClient(0, 0)
    dbMocks.connect.mockResolvedValue(client)
    const repository = new BaseKnowledgeRepository()
    ;(repository as any).initializationPromise = Promise.resolve()

    await expect(repository.deleteDocument('kb-001', 'doc-001')).resolves.toBeUndefined()

    const statements = client.query.mock.calls.map(([sql]) => String(sql))
    expect(statements.some((sql) => sql.includes('DROP TABLE IF EXISTS "test_yddoc"."bk_test"'))).toBe(
      true
    )
    expect(
      statements.some((sql) => sql.includes('DELETE FROM "test_yddoc".base_knowledge_spaces'))
    ).toBe(true)
  })
})
