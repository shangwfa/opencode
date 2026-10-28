import { getDatabaseUrl, getDatabaseSchema } from '../../config/env.js'
import { Pool } from 'pg'
import { PgRowStore } from './pg-row-store.js'

export { PgRowStore } from './pg-row-store.js'
export type { RowRecord, UpsertRowsOptions } from './pg-row-store.js'
export { RowRetriever } from './row-retriever.js'
export type { RowSearchOptions, RowSearchResult } from './row-retriever.js'
export { NaturalLanguageRowQuery } from './nl-row-query.js'
export type { NlRowQueryOptions, NlRowQueryResult } from './nl-row-query.js'
export {
  rowToText,
  validateRow,
  getRowSchemaText,
  RowSchemaZod,
  RowFieldSchemaZod,
} from './schema.js'
export type {
  RowSchema,
  RowField,
  RowData,
  RowFilter,
  RowFilterOp,
  RowFieldType,
  RowFieldValue,
} from './schema.js'

let sharedStore: PgRowStore | null = null

/**
 * 行存储单例（复用图存储的连接管理模式：DATABASE_URL + DATABASE_SCHEMA）
 */
export function getRowStore(schemaName?: string, embeddingDimension?: number): PgRowStore {
  if (!sharedStore) {
    const connectionString = getDatabaseUrl()
    if (!connectionString) {
      throw new Error('DATABASE_URL is required')
    }
    const pool = new Pool({ connectionString })
    const schema = schemaName || getDatabaseSchema()
    sharedStore = new PgRowStore(pool, schema, embeddingDimension)
  }
  return sharedStore
}

export function closeRowStore(): void {
  sharedStore = null
}
