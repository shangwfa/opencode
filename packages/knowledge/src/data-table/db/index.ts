import { drizzle } from 'drizzle-orm/node-postgres'
import { pool, schemaName } from '../../db/index.js'
import { createDatabaseSchema } from './schema.js'

const tables = createDatabaseSchema(schemaName)

export const db = drizzle(pool, { schema: tables, logger: false })
export const { databaseBases } = tables
export { schemaName, pool }

/**
 * 创建 databases 元表（与 knowledge_bases 字段对齐 + 映射字段）。
 * 注意：ALTER relational_data_bases 是对早期表名的存量迁移（旧环境清理废弃列）。
 */
export async function initDatabaseModule(): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`)
    await client.query(`SET search_path TO ${schemaName}, public`)

    await client.query(`
      CREATE TABLE IF NOT EXISTS ${schemaName}.databases (
        id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        embedding_model VARCHAR(255) NOT NULL DEFAULT 'openai/text-embedding-3-small',
        default_chunk_strategy VARCHAR(50) NOT NULL DEFAULT 'recursive',
        default_chunk_config JSONB,
        index_name VARCHAR(255),
        index_dimension INTEGER DEFAULT 1536,
        index_created INTEGER DEFAULT 0,
        index_created_at TIMESTAMP,
        data_table_name VARCHAR(255) NOT NULL UNIQUE,
        column_definitions JSONB NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `)

    // 存量迁移：仅当早期表名的表存在时才清理废弃列（新环境无该表，避免误报）
    const legacy = await client.query(
      `SELECT to_regclass('${schemaName}.relational_data_bases') AS reg`,
    )
    if (legacy.rows[0]?.reg) {
      await client.query(`
        ALTER TABLE ${schemaName}.relational_data_bases
        DROP COLUMN IF EXISTS vectorization_config
      `)
    }
  } finally {
    client.release()
  }
}

// import 时的自执行仅作兜底（历史行为）；正常路径由 app 装配 await initDatabaseModule()，
// 避免「建表未完成就有请求到达」的竞态。
initDatabaseModule().catch((err) => {
  console.error('[database] Failed to initialize databases table:', err.message)
})
