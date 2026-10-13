import type { PoolClient } from 'pg'
import { pool, schemaName } from '../db/index.js'
import { BaseKnowledgeError, SearchTimeoutError } from './errors.js'
import type {
  BaseKnowledgeChunk,
  BaseKnowledgeContentType,
  BaseKnowledgeDocument,
  BaseKnowledgeSearchItem,
  BaseKnowledgeSpace
} from './types.js'
import { getBaseKnowledgeIndexName, quoteIdentifier, toVectorLiteral } from './utils.js'
import { DEFAULT_EMBEDDING_MODEL, MAX_HNSW_VECTOR_DIMENSION } from './constants.js'

const schemaSql = quoteIdentifier(schemaName)

export class BaseKnowledgeRepository {
  private initializationPromise?: Promise<void>

  /**
   * 初始化采用单例 Promise，避免并发首请求重复建表；失败后清空 Promise，允许后续请求重试。
   * 此方法不会在模块 import 时执行，因此新能力故障不会阻断现有 Node-AI 启动。
   */
  async ensureInitialized(): Promise<void> {
    if (!this.initializationPromise) {
      this.initializationPromise = this.initialize().catch((error) => {
        this.initializationPromise = undefined
        throw error
      })
    }
    return this.initializationPromise
  }

  async getEmbeddingModel(knowledgeBaseId: string): Promise<string> {
    await this.ensureInitialized()
    const result = await pool.query(
      `SELECT embedding_model
       FROM ${schemaSql}.knowledge_bases
       WHERE id = $1
       LIMIT 1`,
      [knowledgeBaseId]
    )

    // Base Knowledge 是独立能力：旧知识库存在时复用其模型，不存在时也允许首次写入并自动建空间。
    return result.rows[0]?.embedding_model || DEFAULT_EMBEDDING_MODEL
  }

  async getSpace(knowledgeBaseId: string): Promise<BaseKnowledgeSpace | null> {
    await this.ensureInitialized()
    const result = await pool.query(
      `SELECT knowledge_base_id, embedding_model, embedding_dimension, index_name
       FROM ${schemaSql}.base_knowledge_spaces
       WHERE knowledge_base_id = $1
       LIMIT 1`,
      [knowledgeBaseId]
    )
    return result.rows[0] ? this.mapSpace(result.rows[0]) : null
  }

  async getDocument(knowledgeBaseId: string, documentId: string): Promise<BaseKnowledgeDocument | null> {
    await this.ensureInitialized()
    const result = await pool.query(
      `SELECT knowledge_base_id, document_id, content, normalized_content, content_hash, type,
              chunk_count, version, created_at, updated_at
       FROM ${schemaSql}.base_knowledge
       WHERE knowledge_base_id = $1 AND document_id = $2
       LIMIT 1`,
      [knowledgeBaseId, documentId]
    )
    return result.rows[0] ? this.mapDocument(result.rows[0]) : null
  }

  async createDocument(input: {
    knowledgeBaseId: string
    documentId: string
    content: string
    normalizedContent: string
    contentHash: string
    type: BaseKnowledgeContentType
    embeddingModel: string
    embeddingDimension: number
    chunks: BaseKnowledgeChunk[]
  }): Promise<BaseKnowledgeDocument> {
    await this.ensureInitialized()
    const client = await pool.connect()

    try {
      await client.query('BEGIN')
      await this.lockKnowledgeBaseShared(client, input.knowledgeBaseId)
      await this.lockDocument(client, input.knowledgeBaseId, input.documentId)

      const duplicate = await client.query(
        `SELECT 1 FROM ${schemaSql}.base_knowledge
         WHERE knowledge_base_id = $1 AND document_id = $2`,
        [input.knowledgeBaseId, input.documentId]
      )
      if (duplicate.rowCount) {
        throw new BaseKnowledgeError('Document already exists', 409, 'DOCUMENT_ALREADY_EXISTS')
      }

      const space = await this.ensureSpace(client, {
        knowledgeBaseId: input.knowledgeBaseId,
        embeddingModel: input.embeddingModel,
        embeddingDimension: input.embeddingDimension,
        indexName: getBaseKnowledgeIndexName(input.knowledgeBaseId)
      })
      this.assertDimension(space, input.embeddingDimension)

      await this.insertChunks(client, space, input.chunks)
      const result = await client.query(
        `INSERT INTO ${schemaSql}.base_knowledge (
           knowledge_base_id, document_id, content, normalized_content, content_hash, type, chunk_count
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING knowledge_base_id, document_id, content, normalized_content, content_hash, type,
                   chunk_count, version, created_at, updated_at`,
        [
          input.knowledgeBaseId,
          input.documentId,
          input.content,
          input.normalizedContent,
          input.contentHash,
          input.type,
          input.chunks.length
        ]
      )
      await client.query('COMMIT')
      return this.mapDocument(result.rows[0])
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  async replaceDocument(input: {
    knowledgeBaseId: string
    documentId: string
    content: string
    normalizedContent: string
    contentHash: string
    type: BaseKnowledgeContentType
    expectedVersion: number
    embeddingDimension: number
    chunks: BaseKnowledgeChunk[]
  }): Promise<BaseKnowledgeDocument> {
    await this.ensureInitialized()
    const client = await pool.connect()

    try {
      await client.query('BEGIN')
      await this.lockKnowledgeBaseShared(client, input.knowledgeBaseId)
      await this.lockDocument(client, input.knowledgeBaseId, input.documentId)

      const current = await client.query(
        `SELECT knowledge_base_id, document_id, content, normalized_content, content_hash, type,
                chunk_count, version, created_at, updated_at
         FROM ${schemaSql}.base_knowledge
         WHERE knowledge_base_id = $1 AND document_id = $2
         FOR UPDATE`,
        [input.knowledgeBaseId, input.documentId]
      )
      if (!current.rowCount) {
        throw new BaseKnowledgeError('Document not found', 404, 'DOCUMENT_NOT_FOUND')
      }
      if (current.rows[0].content_hash === input.contentHash) {
        await client.query('COMMIT')
        return this.mapDocument(current.rows[0])
      }
      if (Number(current.rows[0].version) !== input.expectedVersion) {
        throw new BaseKnowledgeError(
          'Document was updated by another request; reload it before retrying',
          409,
          'DOCUMENT_VERSION_CONFLICT'
        )
      }

      const space = await this.getSpaceForUpdate(client, input.knowledgeBaseId, true)
      this.assertDimension(space, input.embeddingDimension)
      const tableSql = `${schemaSql}.${quoteIdentifier(space.indexName)}`

      // 旧 chunk 删除、新 chunk 写入和业务记录更新在同一事务中，检索只能看到完整旧版或完整新版。
      await client.query(`DELETE FROM ${tableSql} WHERE document_id = $1`, [input.documentId])
      await this.insertChunks(client, space, input.chunks)

      const result = await client.query(
        `UPDATE ${schemaSql}.base_knowledge
         SET content = $3,
             normalized_content = $4,
             content_hash = $5,
             type = $6,
             chunk_count = $7,
             version = version + 1,
             updated_at = NOW()
         WHERE knowledge_base_id = $1 AND document_id = $2
         RETURNING knowledge_base_id, document_id, content, normalized_content, content_hash, type,
                   chunk_count, version, created_at, updated_at`,
        [
          input.knowledgeBaseId,
          input.documentId,
          input.content,
          input.normalizedContent,
          input.contentHash,
          input.type,
          input.chunks.length
        ]
      )
      await client.query('COMMIT')
      return this.mapDocument(result.rows[0])
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  async deleteDocument(knowledgeBaseId: string, documentId: string): Promise<void> {
    await this.ensureInitialized()
    const client = await pool.connect()

    try {
      await client.query('BEGIN')
      // 删除最后一篇文档时需要 DROP 向量表，因此这里使用知识库排他锁，
      // 避免与并发检索、写入或另一篇文档删除发生“判断为空后又写入”的竞争。
      await this.lockKnowledgeBaseExclusive(client, knowledgeBaseId)
      await this.lockDocument(client, knowledgeBaseId, documentId)
      const space = await this.getSpaceForUpdate(client, knowledgeBaseId, true)
      const deleted = await client.query(
        `DELETE FROM ${schemaSql}.base_knowledge
         WHERE knowledge_base_id = $1 AND document_id = $2
         RETURNING document_id`,
        [knowledgeBaseId, documentId]
      )

      await client.query(
        `DELETE FROM ${schemaSql}.${quoteIdentifier(space.indexName)} WHERE document_id = $1`,
        [documentId]
      )

      const remaining = await client.query(
        `SELECT 1
         FROM ${schemaSql}.base_knowledge
         WHERE knowledge_base_id = $1
         LIMIT 1`,
        [knowledgeBaseId]
      )
      if (!remaining.rowCount) {
        // 最后一篇文档删除后不保留空命名空间：配置记录和物理向量表在同一事务中清理。
        await client.query(`DROP TABLE IF EXISTS ${schemaSql}.${quoteIdentifier(space.indexName)}`)
        await client.query(
          `DELETE FROM ${schemaSql}.base_knowledge_spaces WHERE knowledge_base_id = $1`,
          [knowledgeBaseId]
        )
      } else if (!deleted.rowCount) {
        // 还有其他文档时，传入的 documentId 确实不存在；抛错会回滚上面的所有操作。
        throw new BaseKnowledgeError('Document not found', 404, 'DOCUMENT_NOT_FOUND')
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  async deleteKnowledgeBase(knowledgeBaseId: string): Promise<void> {
    await this.ensureInitialized()
    const client = await pool.connect()

    try {
      await client.query('BEGIN')
      // 删除命名空间使用排他锁，与检索和文档写入的共享锁互斥。
      await this.lockKnowledgeBaseExclusive(client, knowledgeBaseId)
      const space = await this.getSpaceForUpdate(client, knowledgeBaseId, false)
      if (!space) {
        throw new BaseKnowledgeError('Base knowledge not found', 404, 'BASE_KNOWLEDGE_NOT_FOUND')
      }

      await client.query(`DROP TABLE IF EXISTS ${schemaSql}.${quoteIdentifier(space.indexName)}`)
      await client.query(`DELETE FROM ${schemaSql}.base_knowledge WHERE knowledge_base_id = $1`, [knowledgeBaseId])
      await client.query(`DELETE FROM ${schemaSql}.base_knowledge_spaces WHERE knowledge_base_id = $1`, [
        knowledgeBaseId
      ])
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  async keywordSearch(
    knowledgeBaseId: string,
    query: string,
    topK: number,
    excludeDocumentIds: string[],
    timeoutMs: number
  ): Promise<BaseKnowledgeSearchItem[]> {
    return this.runSearchTransaction('keyword', knowledgeBaseId, timeoutMs, async (client, space) => {
      const tableSql = `${schemaSql}.${quoteIdentifier(space.indexName)}`
      const escaped = query.replace(/[\\%_]/g, '\\$&')
      const params: unknown[] = [`%${escaped}%`, query, topK]
      const exclusion =
        excludeDocumentIds.length > 0
          ? `AND NOT (document_id = ANY($${params.push(excludeDocumentIds)}::text[]))`
          : ''

      const result = await client.query(
        `SELECT vector_id, document_id, chunk_index, content, metadata,
                GREATEST(
                  CASE WHEN content ILIKE $1 ESCAPE E'\\\\' THEN 1.0 ELSE 0.0 END,
                  similarity(content, $2)
                ) AS score
         FROM ${tableSql}
         WHERE (
           content ILIKE $1 ESCAPE E'\\\\'
           OR similarity(content, $2) > 0.1
         )
         ${exclusion}
         ORDER BY score DESC
         LIMIT $3`,
        params
      )
      return result.rows.map((row) => this.mapSearchItem(row))
    })
  }

  async vectorSearch(
    knowledgeBaseId: string,
    embedding: number[],
    topK: number,
    excludeDocumentIds: string[],
    timeoutMs: number
  ): Promise<BaseKnowledgeSearchItem[]> {
    return this.runSearchTransaction('vector', knowledgeBaseId, timeoutMs, async (client, space) => {
      this.assertDimension(space, embedding.length)
      const params: unknown[] = [toVectorLiteral(embedding), topK]
      const exclusion =
        excludeDocumentIds.length > 0
          ? `WHERE NOT (document_id = ANY($${params.push(excludeDocumentIds)}::text[]))`
          : ''
      const result = await client.query(
        `SELECT vector_id, document_id, chunk_index, content, metadata,
                1 - (embedding <=> $1::vector) AS score
         FROM ${schemaSql}.${quoteIdentifier(space.indexName)}
         ${exclusion}
         ORDER BY embedding <=> $1::vector
         LIMIT $2`,
        params
      )
      return result.rows.map((row) => this.mapSearchItem(row))
    })
  }

  private async initialize(): Promise<void> {
    const client = await pool.connect()
    try {
      const extensions = await client.query(
        `SELECT extname FROM pg_extension WHERE extname = ANY($1::text[])`,
        [['vector', 'pg_trgm']]
      )
      const installed = new Set(extensions.rows.map((row) => row.extname))
      for (const extension of ['vector', 'pg_trgm']) {
        if (!installed.has(extension)) {
          await client.query(`CREATE EXTENSION IF NOT EXISTS ${quoteIdentifier(extension)} SCHEMA public`)
        }
      }

      await client.query(`
        CREATE TABLE IF NOT EXISTS ${schemaSql}.base_knowledge_spaces (
          knowledge_base_id VARCHAR(255) PRIMARY KEY,
          embedding_model VARCHAR(255) NOT NULL,
          embedding_dimension INTEGER NOT NULL,
          index_name VARCHAR(63) NOT NULL UNIQUE,
          created_at TIMESTAMP NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
          CHECK (embedding_dimension > 0)
        )
      `)
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${schemaSql}.base_knowledge (
          knowledge_base_id VARCHAR(255) NOT NULL,
          document_id VARCHAR(255) NOT NULL,
          content TEXT NOT NULL,
          normalized_content TEXT NOT NULL,
          content_hash VARCHAR(64) NOT NULL,
          type VARCHAR(50) NOT NULL,
          chunk_count INTEGER NOT NULL DEFAULT 0,
          version INTEGER NOT NULL DEFAULT 1,
          created_at TIMESTAMP NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
          PRIMARY KEY (knowledge_base_id, document_id),
          CHECK (type IN ('text', 'markdown', 'html', 'tiptap')),
          CHECK (chunk_count >= 0),
          CHECK (version > 0)
        )
      `)
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_base_knowledge_kb
        ON ${schemaSql}.base_knowledge (knowledge_base_id)
      `)
    } finally {
      client.release()
    }
  }

  private async ensureSpace(client: PoolClient, requested: BaseKnowledgeSpace): Promise<BaseKnowledgeSpace> {
    // 共享知识库锁允许不同文档并发写入；首次建命名空间需额外串行化，避免唯一键竞争。
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [
      'base-knowledge-space',
      requested.knowledgeBaseId
    ])
    const existing = await client.query(
      `SELECT knowledge_base_id, embedding_model, embedding_dimension, index_name
       FROM ${schemaSql}.base_knowledge_spaces
       WHERE knowledge_base_id = $1
       FOR UPDATE`,
      [requested.knowledgeBaseId]
    )
    if (existing.rows[0]) return this.mapSpace(existing.rows[0])

    await client.query(
      `INSERT INTO ${schemaSql}.base_knowledge_spaces (
         knowledge_base_id, embedding_model, embedding_dimension, index_name
       ) VALUES ($1, $2, $3, $4)`,
      [
        requested.knowledgeBaseId,
        requested.embeddingModel,
        requested.embeddingDimension,
        requested.indexName
      ]
    )
    await this.createPhysicalTable(client, requested)
    return requested
  }

  private async createPhysicalTable(client: PoolClient, space: BaseKnowledgeSpace): Promise<void> {
    if (
      !Number.isInteger(space.embeddingDimension) ||
      space.embeddingDimension <= 0 ||
      space.embeddingDimension > MAX_HNSW_VECTOR_DIMENSION
    ) {
      throw new BaseKnowledgeError('Invalid embedding dimension', 422, 'INVALID_EMBEDDING_DIMENSION')
    }

    const tableSql = `${schemaSql}.${quoteIdentifier(space.indexName)}`
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${tableSql} (
        vector_id TEXT PRIMARY KEY,
        document_id VARCHAR(255) NOT NULL,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        embedding vector(${space.embeddingDimension}) NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${space.indexName}_embedding_idx`)}
      ON ${tableSql}
      USING hnsw (embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 64)
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${space.indexName}_content_trgm_idx`)}
      ON ${tableSql}
      USING GIN (content gin_trgm_ops)
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${space.indexName}_document_idx`)}
      ON ${tableSql} (document_id)
    `)
  }

  private async insertChunks(client: PoolClient, space: BaseKnowledgeSpace, chunks: BaseKnowledgeChunk[]): Promise<void> {
    const tableSql = `${schemaSql}.${quoteIdentifier(space.indexName)}`
    const batchSize = 100

    for (let offset = 0; offset < chunks.length; offset += batchSize) {
      const batch = chunks.slice(offset, offset + batchSize)
      const params: unknown[] = []
      const values = batch.map((chunk) => {
        const base = params.length
        params.push(
          chunk.id,
          chunk.documentId,
          chunk.chunkIndex,
          chunk.text,
          toVectorLiteral(chunk.embedding),
          JSON.stringify(chunk.metadata)
        )
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::vector, $${base + 6}::jsonb)`
      })
      await client.query(
        `INSERT INTO ${tableSql} (
           vector_id, document_id, chunk_index, content, embedding, metadata
         ) VALUES ${values.join(', ')}`,
        params
      )
    }
  }

  private async runSearchTransaction<T>(
    branch: 'keyword' | 'vector',
    knowledgeBaseId: string,
    timeoutMs: number,
    operation: (client: PoolClient, space: BaseKnowledgeSpace) => Promise<T>
  ): Promise<T> {
    await this.ensureInitialized()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('statement_timeout', $1, true)`, [`${timeoutMs}ms`])
      await this.lockKnowledgeBaseShared(client, knowledgeBaseId)
      const space = await this.getSpaceForRead(client, knowledgeBaseId)
      const result = await operation(client, space)
      await client.query('COMMIT')
      return result
    } catch (error: any) {
      await client.query('ROLLBACK').catch(() => undefined)
      if (error?.code === '57014') throw new SearchTimeoutError(branch)
      throw error
    } finally {
      client.release()
    }
  }

  private async lockKnowledgeBaseShared(client: PoolClient, knowledgeBaseId: string): Promise<void> {
    await client.query(`SELECT pg_advisory_xact_lock_shared(hashtext('base-knowledge:' || $1))`, [
      knowledgeBaseId
    ])
  }

  private async lockKnowledgeBaseExclusive(client: PoolClient, knowledgeBaseId: string): Promise<void> {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('base-knowledge:' || $1))`, [
      knowledgeBaseId
    ])
  }

  private async lockDocument(client: PoolClient, knowledgeBaseId: string, documentId: string): Promise<void> {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [
      `base-knowledge:${knowledgeBaseId}`,
      documentId
    ])
  }

  private async getSpaceForUpdate(
    client: PoolClient,
    knowledgeBaseId: string,
    required: true
  ): Promise<BaseKnowledgeSpace>
  private async getSpaceForUpdate(
    client: PoolClient,
    knowledgeBaseId: string,
    required: false
  ): Promise<BaseKnowledgeSpace | null>
  private async getSpaceForUpdate(
    client: PoolClient,
    knowledgeBaseId: string,
    required = true
  ): Promise<BaseKnowledgeSpace | null> {
    const result = await client.query(
      `SELECT knowledge_base_id, embedding_model, embedding_dimension, index_name
       FROM ${schemaSql}.base_knowledge_spaces
       WHERE knowledge_base_id = $1
       FOR UPDATE`,
      [knowledgeBaseId]
    )
    if (!result.rows[0] && required) {
      throw new BaseKnowledgeError('Base knowledge not found', 404, 'BASE_KNOWLEDGE_NOT_FOUND')
    }
    return result.rows[0] ? this.mapSpace(result.rows[0]) : null
  }

  private async getSpaceForRead(client: PoolClient, knowledgeBaseId: string): Promise<BaseKnowledgeSpace> {
    const result = await client.query(
      `SELECT knowledge_base_id, embedding_model, embedding_dimension, index_name
       FROM ${schemaSql}.base_knowledge_spaces
       WHERE knowledge_base_id = $1`,
      [knowledgeBaseId]
    )
    if (!result.rows[0]) {
      throw new BaseKnowledgeError('Base knowledge not found', 404, 'BASE_KNOWLEDGE_NOT_FOUND')
    }
    return this.mapSpace(result.rows[0])
  }

  private assertDimension(space: BaseKnowledgeSpace, actualDimension: number): void {
    if (space.embeddingDimension !== actualDimension) {
      throw new BaseKnowledgeError(
        `Embedding dimension mismatch: expected ${space.embeddingDimension}, got ${actualDimension}`,
        409,
        'EMBEDDING_DIMENSION_MISMATCH'
      )
    }
  }

  private mapSpace(row: any): BaseKnowledgeSpace {
    return {
      knowledgeBaseId: row.knowledge_base_id,
      embeddingModel: row.embedding_model,
      embeddingDimension: Number(row.embedding_dimension),
      indexName: row.index_name
    }
  }

  private mapDocument(row: any): BaseKnowledgeDocument {
    return {
      knowledgeBaseId: row.knowledge_base_id,
      documentId: row.document_id,
      content: row.content,
      normalizedContent: row.normalized_content,
      contentHash: row.content_hash,
      type: row.type,
      chunkCount: Number(row.chunk_count),
      version: Number(row.version),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }

  private mapSearchItem(row: any): BaseKnowledgeSearchItem {
    return {
      id: row.vector_id,
      documentId: row.document_id,
      chunkIndex: Number(row.chunk_index),
      text: row.content,
      score: Number(row.score),
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata || {}
    }
  }
}
