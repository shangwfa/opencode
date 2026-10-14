import type { PoolClient } from 'pg'

/** 既有表也必须升级；事务 + schema 级锁使多个 pod 启动时可重复执行。 */
export async function migrateWikiProvenance(client: PoolClient, schemaName: string): Promise<void> {
  await client.query('BEGIN')
  try {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${schemaName}:wiki-provenance-v1`])
    await client.query(`ALTER TABLE ${schemaName}.wiki_concepts
      ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS citation_status VARCHAR(50) NOT NULL DEFAULT 'legacy'`)
    await client.query(`ALTER TABLE ${schemaName}.wiki_relationships
      ADD COLUMN IF NOT EXISTS origin VARCHAR(50) NOT NULL DEFAULT 'legacy',
      ADD COLUMN IF NOT EXISTS source_revision INTEGER,
      ADD COLUMN IF NOT EXISTS evidence JSONB NOT NULL DEFAULT '[]'::jsonb`)
    await client.query(`ALTER TABLE ${schemaName}.wiki_compile_tasks
      ADD COLUMN IF NOT EXISTS document_id VARCHAR(255),
      ADD COLUMN IF NOT EXISTS worker_id VARCHAR(255),
      ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS attempt INTEGER NOT NULL DEFAULT 0`)
    // 遗留 running 任务没有租约，视为过期并允许被恢复器接管。
    await client.query(`UPDATE ${schemaName}.wiki_compile_tasks SET lease_expires_at=NOW()-INTERVAL '1 second'
      WHERE status='running' AND lease_expires_at IS NULL`)
    await client.query(`CREATE INDEX IF NOT EXISTS idx_wiki_compile_tasks_lease
      ON ${schemaName}.wiki_compile_tasks(status,lease_expires_at)`)
    await client.query(`CREATE TABLE IF NOT EXISTS ${schemaName}.wiki_page_revisions (
      id VARCHAR(255) PRIMARY KEY,
      concept_id VARCHAR(255) NOT NULL REFERENCES ${schemaName}.wiki_concepts(id) ON DELETE CASCADE,
      collection_id VARCHAR(255) NOT NULL REFERENCES ${schemaName}.wiki_collections(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      task_id VARCHAR(255),
      reason VARCHAR(50) NOT NULL,
      page_snapshot JSONB NOT NULL,
      source_snapshot JSONB NOT NULL,
      relationship_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE(concept_id, revision)
    )`)
    await client.query(`ALTER TABLE ${schemaName}.wiki_page_revisions
      ADD COLUMN IF NOT EXISTS relationship_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb`)
    // 追加式操作日志：只允许 INSERT；UPDATE/DELETE 由触发器拒绝（Karpathy log.md 的服务化对应）。
    await client.query(`CREATE TABLE IF NOT EXISTS ${schemaName}.wiki_activity_log (
      id VARCHAR(255) PRIMARY KEY,
      collection_id VARCHAR(255) NOT NULL,
      type VARCHAR(50) NOT NULL,
      detail JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )`)
    await client.query(`CREATE OR REPLACE FUNCTION ${schemaName}.wiki_activity_log_append_only()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'wiki_activity_log is append-only';
      END;
      $$ LANGUAGE plpgsql`)
    await client.query(`DROP TRIGGER IF EXISTS trg_wiki_activity_log_append ON ${schemaName}.wiki_activity_log`)
    await client.query(`CREATE TRIGGER trg_wiki_activity_log_append
      BEFORE UPDATE OR DELETE ON ${schemaName}.wiki_activity_log
      FOR EACH ROW EXECUTE FUNCTION ${schemaName}.wiki_activity_log_append_only()`)
    // 用户可编辑 schema：按集合版本化（追加式，读取时取最新版本）。
    await client.query(`CREATE TABLE IF NOT EXISTS ${schemaName}.wiki_schemas (
      id VARCHAR(255) PRIMARY KEY,
      collection_id VARCHAR(255) NOT NULL,
      version INTEGER NOT NULL,
      config JSONB NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE(collection_id, version)
    )`)
    // schema 配置随集合删除（与日志的"保留审计"不同：配置无独立价值）；先清孤儿再加约束（幂等）。
    await client.query(`DELETE FROM ${schemaName}.wiki_schemas s
      WHERE NOT EXISTS (SELECT 1 FROM ${schemaName}.wiki_collections c WHERE c.id = s.collection_id)`)
    await client.query(`DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wiki_schemas_collection_id_fkey'
          AND conrelid = '${schemaName}.wiki_schemas'::regclass) THEN
          ALTER TABLE ${schemaName}.wiki_schemas
            ADD CONSTRAINT wiki_schemas_collection_id_fkey
            FOREIGN KEY (collection_id) REFERENCES ${schemaName}.wiki_collections(id) ON DELETE CASCADE;
        END IF;
      END $$`)
    // 不能把当前文档内容冒充旧页面编译时的原文；基线只保存旧关联及“版本未知”。
    await client.query(`INSERT INTO ${schemaName}.wiki_page_revisions
      (id,concept_id,collection_id,revision,reason,page_snapshot,source_snapshot)
      SELECT 'wiki_baseline_' || c.id,c.id,c.collection_id,0,'legacy-baseline',to_jsonb(c),
        COALESCE((SELECT jsonb_agg(jsonb_build_object('documentId',s.document_id,
          'contentHash',s.content_hash,'historicalContentUnavailable',true))
          FROM ${schemaName}.wiki_concept_sources s WHERE s.concept_id=c.id),'[]'::jsonb)
      FROM ${schemaName}.wiki_concepts c WHERE c.revision=0
      ON CONFLICT(concept_id,revision) DO NOTHING`)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}
