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
  menus,
  kbAliases,
  kbModes,
  documentSyncTasks,
  compatUploads,
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

    // ── 文档平台（doc-platform）迁移：knowledge_bases/documents 产品化列 ──
    try {
      await client.query(`
        ALTER TABLE ${schemaName}.knowledge_bases
        ADD COLUMN IF NOT EXISTS slug VARCHAR(64),
        ADD COLUMN IF NOT EXISTS language_code VARCHAR(32),
        ADD COLUMN IF NOT EXISTS is_public INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS owner_id VARCHAR(64),
        ADD COLUMN IF NOT EXISTS settings JSONB
      `)
      await client.query(`
        ALTER TABLE ${schemaName}.documents
        ADD COLUMN IF NOT EXISTS menu_id VARCHAR(64),
        ADD COLUMN IF NOT EXISTS content_json JSONB,
        ADD COLUMN IF NOT EXISTS draft_content_json JSONB,
        ADD COLUMN IF NOT EXISTS published_at TIMESTAMP
      `)
    } catch (error: any) {
      if (!error.message?.includes("already exists") && !error.message?.includes("duplicate column")) {
        console.warn("[knowledge/db] 补齐 doc-platform 字段失败:", error.message)
      }
    }

    // slug 唯一约束（允许 NULL：存量 RAG 库无 slug）
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uk_knowledge_bases_slug
      ON ${schemaName}.knowledge_bases(slug) WHERE slug IS NOT NULL
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_documents_menu_id
      ON ${schemaName}.documents(menu_id)
    `)

    // ── 菜单树 ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${schemaName}.menus (
        id VARCHAR(64) PRIMARY KEY,
        knowledge_base_id VARCHAR(255) NOT NULL REFERENCES ${schemaName}.knowledge_bases(id) ON DELETE CASCADE,
        parent_id VARCHAR(64),
        previous_id VARCHAR(64),
        name VARCHAR(255) NOT NULL,
        type VARCHAR(16) NOT NULL DEFAULT 'doc',
        icon_url TEXT,
        slug VARCHAR(255),
        enable INTEGER NOT NULL DEFAULT 1,
        doc_unique_id VARCHAR(64),
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_menus_kb_parent
      ON ${schemaName}.menus(knowledge_base_id, parent_id)
    `)
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uk_menus_kb_slug
      ON ${schemaName}.menus(knowledge_base_id, slug) WHERE slug IS NOT NULL
    `)

    // ── 别名 ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${schemaName}.kb_aliases (
        alias VARCHAR(255) PRIMARY KEY,
        knowledge_base_id VARCHAR(255) NOT NULL REFERENCES ${schemaName}.knowledge_bases(id) ON DELETE CASCADE,
        menu_id VARCHAR(64) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_kb_aliases_kb
      ON ${schemaName}.kb_aliases(knowledge_base_id)
    `)

    // ── 知识库×检索模式 ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${schemaName}.kb_modes (
        knowledge_base_id VARCHAR(255) NOT NULL REFERENCES ${schemaName}.knowledge_bases(id) ON DELETE CASCADE,
        mode VARCHAR(16) NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        backend_id VARCHAR(255),
        config JSONB,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
        PRIMARY KEY (knowledge_base_id, mode)
      )
    `)

    // ── 文档派生任务 ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${schemaName}.document_sync_tasks (
        id VARCHAR(255) PRIMARY KEY,
        knowledge_base_id VARCHAR(255) NOT NULL REFERENCES ${schemaName}.knowledge_bases(id) ON DELETE CASCADE,
        document_id VARCHAR(255) NOT NULL,
        mode VARCHAR(16) NOT NULL,
        operation VARCHAR(16) NOT NULL,
        published INTEGER NOT NULL DEFAULT 1,
        status VARCHAR(16) NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_doc_sync_tasks_doc
      ON ${schemaName}.document_sync_tasks(document_id)
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_doc_sync_tasks_status
      ON ${schemaName}.document_sync_tasks(status)
    `)

    // ── v1 兼容层:正文/草稿上传缓存(saveDoc/draft 的 content key → 内容) ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${schemaName}.compat_uploads (
        key VARCHAR(255) PRIMARY KEY,
        knowledge_base_id VARCHAR(255),
        kind VARCHAR(16) NOT NULL DEFAULT 'doc',
        content_type VARCHAR(128),
        payload JSONB,
        blob_url TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `)

  } finally {
    client.release()
  }
}
