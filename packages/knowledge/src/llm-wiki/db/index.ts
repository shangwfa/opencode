/**
 * llm-wiki 子模块的数据库初始化（自包含，模式同 data-table）。
 *
 * 复用主 db 连接（db/pool/schemaName/documents），wiki 表的 drizzle 定义见 ./schema.ts，
 * 建表 SQL 见 initWikiTables()——由 app 装配统一 await（主 initDatabase 建好 knowledge_bases 后执行）。
 */
import { pool, schemaName } from "../../db/index.js"

export {
  db,
  pool,
  schemaName,
  documents,
} from "../../db/index.js"

export {
  wikiCollections,
  wikiConcepts,
  wikiConceptSources,
  wikiRelationships,
  wikiCompileTasks,
} from "./schema.js"

/**
 * 创建 5 张 wiki 表（幂等）。需在主 initDatabase()（knowledge_bases 表）之后执行。
 */
export async function initWikiTables(): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`)
    await client.query(`SET search_path TO ${schemaName}, public`)

    // Wiki 集合表
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${schemaName}.wiki_collections (
        id VARCHAR(255) PRIMARY KEY,
        knowledge_base_id VARCHAR(255) NOT NULL REFERENCES ${schemaName}.knowledge_bases(id) ON DELETE CASCADE,
        name VARCHAR(255),
        status VARCHAR(50) NOT NULL DEFAULT 'active',
        last_compiled_at TIMESTAMP,
        concept_count INTEGER DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE(knowledge_base_id)
      )
    `)

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_wiki_collections_knowledge_base_id
      ON ${schemaName}.wiki_collections(knowledge_base_id)
    `)

    // Wiki 概念表
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${schemaName}.wiki_concepts (
        id VARCHAR(255) PRIMARY KEY,
        collection_id VARCHAR(255) NOT NULL REFERENCES ${schemaName}.wiki_collections(id) ON DELETE CASCADE,
        concept_name VARCHAR(255) NOT NULL,
        slug VARCHAR(255) NOT NULL,
        definition TEXT,
        summary TEXT,
        content JSONB,
        tags JSONB DEFAULT '[]',
        occurrence_count INTEGER DEFAULT 1,
        status VARCHAR(50) NOT NULL DEFAULT 'compiled',
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE(collection_id, slug)
      )
    `)

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_wiki_concepts_collection_id
      ON ${schemaName}.wiki_concepts(collection_id)
    `)

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_wiki_concepts_name
      ON ${schemaName}.wiki_concepts(concept_name)
    `)

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_wiki_concepts_slug
      ON ${schemaName}.wiki_concepts(slug)
    `)

    // Wiki 概念来源表
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${schemaName}.wiki_concept_sources (
        id VARCHAR(255) PRIMARY KEY,
        concept_id VARCHAR(255) NOT NULL REFERENCES ${schemaName}.wiki_concepts(id) ON DELETE CASCADE,
        document_id VARCHAR(255) NOT NULL,
        content_hash VARCHAR(64) NOT NULL,
        compiled_at TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE(concept_id, document_id)
      )
    `)

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_wiki_concept_sources_concept_id
      ON ${schemaName}.wiki_concept_sources(concept_id)
    `)

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_wiki_concept_sources_document_id
      ON ${schemaName}.wiki_concept_sources(document_id)
    `)

    // Wiki 关系表
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${schemaName}.wiki_relationships (
        id VARCHAR(255) PRIMARY KEY,
        collection_id VARCHAR(255) NOT NULL REFERENCES ${schemaName}.wiki_collections(id) ON DELETE CASCADE,
        source_concept_id VARCHAR(255) NOT NULL REFERENCES ${schemaName}.wiki_concepts(id) ON DELETE CASCADE,
        target_concept_id VARCHAR(255) NOT NULL REFERENCES ${schemaName}.wiki_concepts(id) ON DELETE CASCADE,
        relationship_type VARCHAR(50) NOT NULL,
        strength INTEGER DEFAULT 1,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE(source_concept_id, target_concept_id, relationship_type)
      )
    `)

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_wiki_relationships_source
      ON ${schemaName}.wiki_relationships(source_concept_id)
    `)

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_wiki_relationships_target
      ON ${schemaName}.wiki_relationships(target_concept_id)
    `)

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_wiki_relationships_collection
      ON ${schemaName}.wiki_relationships(collection_id)
    `)

    // Wiki 编译任务表
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${schemaName}.wiki_compile_tasks (
        id VARCHAR(255) PRIMARY KEY,
        collection_id VARCHAR(255) NOT NULL REFERENCES ${schemaName}.wiki_collections(id) ON DELETE CASCADE,
        knowledge_base_id VARCHAR(255) NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'pending',
        progress JSONB NOT NULL DEFAULT '{}',
        error TEXT,
        started_at TIMESTAMP,
        completed_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `)

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_wiki_compile_tasks_collection_id
      ON ${schemaName}.wiki_compile_tasks(collection_id)
    `)

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_wiki_compile_tasks_status
      ON ${schemaName}.wiki_compile_tasks(status)
    `)  } finally {
    client.release()
  }
}
