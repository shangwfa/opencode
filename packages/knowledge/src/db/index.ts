import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"
import { createSchema } from "./schema.js"
import { getDatabaseSchema, getDatabaseUrl } from "../config/env.js"
import { ensurePgSchema } from "./ensure-schema.js"

const connectionString = getDatabaseUrl()
const schemaName = getDatabaseSchema()

if (!connectionString) {
  throw new Error(
    "KNOWLEDGE_DATABASE_URL (or DATABASE_URL / OPENCODE_DATABASE_URL) is required for @opencode/knowledge",
  )
}

// 创建连接池
const pool = new Pool({ connectionString })

// 创建 Drizzle 实例
// 注意：Drizzle 的 schema 参数用于类型推断，实际表在指定 schema 下
// 需要设置 search_path 或使用 schema.table 格式
const schema = createSchema(schemaName)

export const db = drizzle(pool, {
  schema,
  logger: false,
})

// 导出 schema 和表
export const {
  knowledgeBases,
  documents,
  syncTasks,
} = schema
export { schemaName, pool }

/**
 * 初始化数据库（创建 schema 和表）。幂等，可重复调用。
 * 由服务启动时（server.ts / createKnowledgeApp）调用。
 */
export async function initDatabase() {
  const client = await pool.connect()
  try {
    // 创建 schema（如果不存在，幂等容错）
    await ensurePgSchema(client, schemaName)

    // 设置 search_path
    await client.query(`SET search_path TO ${schemaName}, public`)

    await client.query(`
      CREATE TABLE IF NOT EXISTS ${schemaName}.knowledge_bases (
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
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `)

    await client.query(`
      CREATE TABLE IF NOT EXISTS ${schemaName}.documents (
        id VARCHAR(255) PRIMARY KEY,
        knowledge_base_id VARCHAR(255) NOT NULL REFERENCES ${schemaName}.knowledge_bases(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        type VARCHAR(50) NOT NULL DEFAULT 'text',
        chunk_strategy VARCHAR(50) NOT NULL DEFAULT 'recursive',
        chunk_config JSONB,
        metadata JSONB,
        chunk_count INTEGER NOT NULL DEFAULT 0,
        status VARCHAR(50) NOT NULL DEFAULT 'processing',
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `)

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_documents_knowledge_base_id 
      ON ${schemaName}.documents(knowledge_base_id)
    `)

    // 兼容存量表：补齐 status 字段
    try {
      const columnCheck = await client.query(
        `
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_schema = $1 
        AND table_name = 'documents' 
        AND column_name = 'status'
      `,
        [schemaName],
      )

      if (columnCheck.rows.length === 0) {
        await client.query(`
          ALTER TABLE ${schemaName}.documents
          ADD COLUMN status VARCHAR(50) NOT NULL DEFAULT 'completed'
        `)
        await client.query(`
          UPDATE ${schemaName}.documents
          SET status = 'completed'
          WHERE status IS NULL OR status = ''
        `)
      }
    } catch (statusError: any) {
      console.warn(`[knowledge/db] 检查/添加 status 字段时出错:`, statusError.message)
    }

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_documents_status 
      ON ${schemaName}.documents(status)
    `)

    await client.query(`
      CREATE TABLE IF NOT EXISTS ${schemaName}.sync_tasks (
        id VARCHAR(255) PRIMARY KEY,
        knowledge_base_id VARCHAR(255) NOT NULL REFERENCES ${schemaName}.knowledge_bases(id) ON DELETE CASCADE,
        status VARCHAR(50) NOT NULL DEFAULT 'pending',
        config JSONB NOT NULL,
        progress JSONB NOT NULL DEFAULT '{}',
        failed_documents JSONB DEFAULT '[]',
        error TEXT,
        started_at TIMESTAMP,
        completed_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `)

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_sync_tasks_knowledge_base_id
      ON ${schemaName}.sync_tasks(knowledge_base_id)
    `)

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_sync_tasks_status
      ON ${schemaName}.sync_tasks(status)
    `)

    // 迁移：为现有表添加索引相关字段（如果不存在）
    try {
      await client.query(`
        ALTER TABLE ${schemaName}.knowledge_bases
        ADD COLUMN IF NOT EXISTS index_name VARCHAR(255),
        ADD COLUMN IF NOT EXISTS index_dimension INTEGER DEFAULT 1536,
        ADD COLUMN IF NOT EXISTS index_created INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS index_created_at TIMESTAMP
      `)
    } catch (error: any) {
      if (!error.message?.includes("already exists") && !error.message?.includes("duplicate column")) {
        console.warn("[knowledge/db] 补齐 index 字段失败:", error.message)
      }
    }

  } finally {
    client.release()
  }
}
