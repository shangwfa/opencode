import { getDatabaseUrl, getDatabaseSchema } from '../../config/env.js'
import { Pool } from 'pg'
import { PgGraphAdapter } from './adapter.js'

let sharedAdapter: PgGraphAdapter | null = null
let sharedPool: Pool | null = null

function getPool(): Pool {
  if (!sharedPool) {
    const connectionString = getDatabaseUrl()
    if (!connectionString) {
      throw new Error('DATABASE_URL is required')
    }
    sharedPool = new Pool({ connectionString })
  }
  return sharedPool
}

export function getGraphAdapter(schemaName?: string): PgGraphAdapter {
  if (!sharedAdapter) {
    const pool = getPool()
    const schema = schemaName || getDatabaseSchema()
    sharedAdapter = new PgGraphAdapter(pool, schema)
  }
  return sharedAdapter
}

export async function initGraphEngine(schemaName?: string): Promise<PgGraphAdapter> {
  const adapter = getGraphAdapter(schemaName)
  await adapter.init()
  return adapter
}

export function closeGraphEngine(): void {
  sharedAdapter = null
  if (sharedPool) {
    sharedPool.end().catch(() => {})
    sharedPool = null
  }
}