import { Pool } from 'pg'

/**
 * Chunk tracking 存储接口
 *
 * 维护每个实体/关系对应的完整 chunk 列表（LightRAG 的 entity_chunks_storage /
 * relation_chunks_storage 等价物）。
 *
 * 用途：
 * - 幂等增量更新：reprocess 时不会重复积累
 * - 删除溯源：按文档删除时能精确追溯哪些实体/关系受影响
 * - 证据计数：关系的 weight 下限 = distinct chunk 数
 */
export interface EntityChunkTracker {
  addEntityChunk(entityId: string, chunkId: string, knowledgeBaseId: string): Promise<void>
  getEntityChunks(entityId: string): Promise<string[]>
  removeEntityChunk(entityId: string, chunkId: string): Promise<void>
  removeEntityChunksByDocument(documentId: string): Promise<string[]>

  addRelationChunk(
    sourceId: string, targetId: string, relationName: string,
    chunkId: string, knowledgeBaseId: string
  ): Promise<void>
  getRelationChunks(sourceId: string, targetId: string, relationName: string): Promise<string[]>
  removeRelationChunk(sourceId: string, targetId: string, relationName: string, chunkId: string): Promise<void>
  removeRelationChunksByDocument(documentId: string): Promise<Array<{ sourceId: string; targetId: string; relationName: string }>>

  getEntityIdsByDocument(documentId: string): Promise<string[]>
  getRelationKeysByDocument(documentId: string): Promise<Array<{ sourceId: string; targetId: string; relationName: string }>>
}

export class PgEntityChunkTracker implements EntityChunkTracker {
  constructor(
    private pool: Pool,
    private schemaName: string
  ) {}

  private async withClient<T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query(`SET search_path TO ${this.schemaName}, public`)
      return await fn(client)
    } finally {
      client.release()
    }
  }

  async initTables(): Promise<void> {
    await this.withClient(async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.schemaName}.entity_chunks (
          entity_id UUID NOT NULL,
          chunk_id VARCHAR(255) NOT NULL,
          knowledge_base_id VARCHAR(255) NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (entity_id, chunk_id)
        )
      `)
      await client.query(`CREATE INDEX IF NOT EXISTS idx_ec_kb ON ${this.schemaName}.entity_chunks(knowledge_base_id)`)
      await client.query(`CREATE INDEX IF NOT EXISTS idx_ec_chunk ON ${this.schemaName}.entity_chunks(chunk_id)`)

      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.schemaName}.relation_chunks (
          source_id UUID NOT NULL,
          target_id UUID NOT NULL,
          relationship_name VARCHAR(255) NOT NULL,
          chunk_id VARCHAR(255) NOT NULL,
          knowledge_base_id VARCHAR(255) NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (source_id, target_id, relationship_name, chunk_id)
        )
      `)
      await client.query(`CREATE INDEX IF NOT EXISTS idx_rc_kb ON ${this.schemaName}.relation_chunks(knowledge_base_id)`)
      await client.query(`CREATE INDEX IF NOT EXISTS idx_rc_chunk ON ${this.schemaName}.relation_chunks(chunk_id)`)
    })
  }

  async addEntityChunk(entityId: string, chunkId: string, knowledgeBaseId: string): Promise<void> {
    await this.withClient(async (client) => {
      await client.query(
        `INSERT INTO ${this.schemaName}.entity_chunks (entity_id, chunk_id, knowledge_base_id)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [entityId, chunkId, knowledgeBaseId]
      )
    })
  }

  async getEntityChunks(entityId: string): Promise<string[]> {
    return this.withClient(async (client) => {
      const r = await client.query(
        `SELECT chunk_id FROM ${this.schemaName}.entity_chunks WHERE entity_id = $1 ORDER BY created_at`,
        [entityId]
      )
      return r.rows.map((row: any) => row.chunk_id)
    })
  }

  async removeEntityChunk(entityId: string, chunkId: string): Promise<void> {
    await this.withClient(async (client) => {
      await client.query(
        `DELETE FROM ${this.schemaName}.entity_chunks WHERE entity_id = $1 AND chunk_id = $2`,
        [entityId, chunkId]
      )
    })
  }

  async removeEntityChunksByDocument(documentId: string): Promise<string[]> {
    return this.withClient(async (client) => {
      const r = await client.query(
        `DELETE FROM ${this.schemaName}.entity_chunks
         WHERE chunk_id LIKE $1
         RETURNING entity_id`,
        [`${documentId}%`]
      )
      return r.rows.map((row: any) => row.entity_id)
    })
  }

  async addRelationChunk(
    sourceId: string, targetId: string, relationName: string,
    chunkId: string, knowledgeBaseId: string
  ): Promise<void> {
    await this.withClient(async (client) => {
      await client.query(
        `INSERT INTO ${this.schemaName}.relation_chunks (source_id, target_id, relationship_name, chunk_id, knowledge_base_id)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
        [sourceId, targetId, relationName, chunkId, knowledgeBaseId]
      )
    })
  }

  async getRelationChunks(sourceId: string, targetId: string, relationName: string): Promise<string[]> {
    return this.withClient(async (client) => {
      const r = await client.query(
        `SELECT chunk_id FROM ${this.schemaName}.relation_chunks
         WHERE source_id = $1 AND target_id = $2 AND relationship_name = $3
         ORDER BY created_at`,
        [sourceId, targetId, relationName]
      )
      return r.rows.map((row: any) => row.chunk_id)
    })
  }

  async removeRelationChunk(
    sourceId: string, targetId: string, relationName: string, chunkId: string
  ): Promise<void> {
    await this.withClient(async (client) => {
      await client.query(
        `DELETE FROM ${this.schemaName}.relation_chunks
         WHERE source_id = $1 AND target_id = $2 AND relationship_name = $3 AND chunk_id = $4`,
        [sourceId, targetId, relationName, chunkId]
      )
    })
  }

  async removeRelationChunksByDocument(documentId: string): Promise<Array<{ sourceId: string; targetId: string; relationName: string }>> {
    return this.withClient(async (client) => {
      const r = await client.query(
        `DELETE FROM ${this.schemaName}.relation_chunks
         WHERE chunk_id LIKE $1
         RETURNING source_id, target_id, relationship_name`,
        [`${documentId}%`]
      )
      return r.rows.map((row: any) => ({
        sourceId: row.source_id,
        targetId: row.target_id,
        relationName: row.relationship_name,
      }))
    })
  }

  async getEntityIdsByDocument(documentId: string): Promise<string[]> {
    return this.withClient(async (client) => {
      const r = await client.query(
        `SELECT DISTINCT entity_id FROM ${this.schemaName}.entity_chunks
         WHERE chunk_id LIKE $1`,
        [`${documentId}%`]
      )
      return r.rows.map((row: any) => row.entity_id)
    })
  }

  async getRelationKeysByDocument(documentId: string): Promise<Array<{ sourceId: string; targetId: string; relationName: string }>> {
    return this.withClient(async (client) => {
      const r = await client.query(
        `SELECT DISTINCT source_id, target_id, relationship_name FROM ${this.schemaName}.relation_chunks
         WHERE chunk_id LIKE $1`,
        [`${documentId}%`]
      )
      return r.rows.map((row: any) => ({
        sourceId: row.source_id,
        targetId: row.target_id,
        relationName: row.relationship_name,
      }))
    })
  }

  async clearKnowledgeBase(knowledgeBaseId: string): Promise<void> {
    await this.withClient(async (client) => {
      await client.query(`DELETE FROM ${this.schemaName}.entity_chunks WHERE knowledge_base_id = $1`, [knowledgeBaseId])
      await client.query(`DELETE FROM ${this.schemaName}.relation_chunks WHERE knowledge_base_id = $1`, [knowledgeBaseId])
    })
  }
}
