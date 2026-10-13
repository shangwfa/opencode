import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import { ensurePgSchema } from '../../db/ensure-schema.js'
import type { OntologyConfig } from './index.js'
import type { OntologyVersion } from './registry.js'

export class PgOntologyRegistry {
  constructor(private pool: Pool, private schemaName: string) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schemaName)) throw new Error('非法 PostgreSQL schema 名称')
  }

  async init(): Promise<void> {
    await ensurePgSchema(this.pool, this.schemaName)
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.schemaName}.ontology_versions (
        ontology_id VARCHAR(255) NOT NULL,
        version INTEGER NOT NULL,
        content_hash VARCHAR(64) NOT NULL,
        status VARCHAR(16) NOT NULL,
        config JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        published_at TIMESTAMPTZ,
        PRIMARY KEY (ontology_id, version)
      )
    `)
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_ontology_active ON ${this.schemaName}.ontology_versions(ontology_id, status, version DESC)`)
  }

  async create(ontologyId: string, config: OntologyConfig): Promise<OntologyVersion> {
    const snapshot = JSON.parse(JSON.stringify(config)) as OntologyConfig
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      // 同一本体的版本号必须串行生成；不同 ontologyId 不互相阻塞。
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [ontologyId])
      const result = await client.query(`SELECT COALESCE(MAX(version), 0) + 1 AS version FROM ${this.schemaName}.ontology_versions WHERE ontology_id = $1`, [ontologyId])
      const version = Number(result.rows[0].version)
      const inserted = await client.query(`
        INSERT INTO ${this.schemaName}.ontology_versions (ontology_id, version, content_hash, status, config)
        VALUES ($1, $2, $3, 'draft', $4::jsonb)
        RETURNING *
      `, [ontologyId, version, hash(snapshot), JSON.stringify(snapshot)])
      await client.query('COMMIT')
      return toVersion(inserted.rows[0])
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async publish(ontologyId: string, version: number): Promise<OntologyVersion> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const target = await client.query(`SELECT * FROM ${this.schemaName}.ontology_versions WHERE ontology_id = $1 AND version = $2 FOR UPDATE`, [ontologyId, version])
      if (target.rowCount === 0) throw new Error(`ontology 版本不存在: ${ontologyId}@${version}`)
      await client.query(`UPDATE ${this.schemaName}.ontology_versions SET status = 'deprecated' WHERE ontology_id = $1 AND status = 'published'`, [ontologyId])
      const published = await client.query(`UPDATE ${this.schemaName}.ontology_versions SET status = 'published', published_at = NOW() WHERE ontology_id = $1 AND version = $2 RETURNING *`, [ontologyId, version])
      await client.query('COMMIT')
      return toVersion(published.rows[0])
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async get(ontologyId: string, version: number): Promise<OntologyVersion | null> {
    const result = await this.pool.query(`SELECT * FROM ${this.schemaName}.ontology_versions WHERE ontology_id = $1 AND version = $2`, [ontologyId, version])
    return result.rows[0] ? toVersion(result.rows[0]) : null
  }

  async getActive(ontologyId: string): Promise<OntologyVersion | null> {
    const result = await this.pool.query(`SELECT * FROM ${this.schemaName}.ontology_versions WHERE ontology_id = $1 AND status = 'published' ORDER BY version DESC LIMIT 1`, [ontologyId])
    return result.rows[0] ? toVersion(result.rows[0]) : null
  }
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function toVersion(row: any): OntologyVersion {
  return {
    ontologyId: row.ontology_id,
    version: Number(row.version),
    contentHash: row.content_hash,
    status: row.status,
    config: row.config,
    createdAt: new Date(row.created_at).toISOString(),
    publishedAt: row.published_at ? new Date(row.published_at).toISOString() : undefined,
  }
}
