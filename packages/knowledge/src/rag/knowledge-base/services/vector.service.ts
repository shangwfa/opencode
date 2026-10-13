import { PgVectorStore } from '../vector/vector-store.js'
import { Pool } from 'pg'
import { getKnowledgeBaseIndexName } from '../../../utils/index-name.js'
import { ensurePgSchema } from '../../../db/ensure-schema.js'

export class VectorService {
  private pgVector: PgVectorStore
  private connectionString: string
  private schemaName: string
  private pool: Pool
  private indexNameCache: Map<string, string> = new Map() // 缓存索引名称

  constructor(connectionString: string, schemaName: string = 'test') {
    this.connectionString = connectionString
    this.schemaName = schemaName
    this.pool = new Pool({ connectionString })
    // PgVectorStore 支持 schemaName 参数
    this.pgVector = new PgVectorStore({
      connectionString,
      schemaName: schemaName
    })
    // 初始化时创建 schema
    this.initSchema()
  }

  /**
   * 初始化 schema
   */
  private async initSchema() {
    const client = await this.pool.connect()
    try {
      await ensurePgSchema(client, this.schemaName)
    } catch (error: any) {
      console.warn('Failed to initialize schema:', error.message)
    } finally {
      client.release()
    }
  }

  /**
   * 创建向量索引
   */
  async createIndex(knowledgeBaseId: string, dimension: number = 1536): Promise<void> {
    const indexName = await this.getIndexName(knowledgeBaseId)
    console.log(`[向量服务] 创建向量索引: ${indexName}, 维度: ${dimension}, schema: ${this.schemaName}`)

    const client = await this.pool.connect()
    try {
      // 设置 search_path 到目标 schema
      await client.query(`SET search_path TO ${this.schemaName}, public`)

      // 先检查表是否已经存在
      const beforeCheck = await client.query(
        `SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = $1 
          AND table_name = $2
        )`,
        [this.schemaName, indexName]
      )
      const tableExists = beforeCheck.rows[0]?.exists
      console.log(`[向量服务] 创建前表是否存在: ${tableExists}`)

      if (tableExists) {
        // 检查表结构是否正确（是否有 vector_id 列）
        const columnCheck = await client.query(
          `SELECT column_name 
           FROM information_schema.columns 
           WHERE table_schema = $1 
           AND table_name = $2 
           AND column_name = 'vector_id'`,
          [this.schemaName, indexName]
        )
        const hasVectorId = columnCheck.rows.length > 0

        if (hasVectorId) {
          console.log(`[向量服务] 表 ${this.schemaName}.${indexName} 已存在且结构正确，跳过创建`)
          return
        } else {
          console.warn(
            `[向量服务] 表 ${this.schemaName}.${indexName} 存在但结构不正确（缺少 vector_id 列），删除并重建`
          )
          await client.query(`DROP TABLE IF EXISTS ${this.schemaName}.${indexName}`)
        }
      }

      // 确保 schema 存在
      await ensurePgSchema(client, this.schemaName)

      // 确保 pgvector 扩展已安装
      try {
        await client.query(`CREATE EXTENSION IF NOT EXISTS vector SCHEMA public`)
      } catch (extError: any) {
        // 如果扩展已存在或无法创建，继续（可能是权限问题）
        console.warn(`[向量服务] pgvector 扩展检查: ${extError.message}`)
      }

      // 尝试使用 pgVector.createIndex() 创建表（它会创建符合 pgVector 期望的表结构）
      // 但需要先设置 search_path，让它在正确的 schema 中创建
      let tableCreatedByPgVector = false
      try {
        // 临时设置 search_path，然后调用 pgVector.createIndex()
        await client.query(`SET search_path TO ${this.schemaName}, public`)

        // 使用 pgVector 创建索引（它会自动创建表）
        await this.pgVector.createIndex({
          indexName,
          dimension,
          metric: 'cosine'
        })
        console.log(`[向量服务] pgVector.createIndex() 调用完成`)

        // 立即验证表是否在正确的 schema 中创建
        const pgVectorCheck = await client.query(
          `SELECT EXISTS (
            SELECT FROM information_schema.tables 
            WHERE table_schema = $1 
            AND table_name = $2
          )`,
          [this.schemaName, indexName]
        )
        tableCreatedByPgVector = pgVectorCheck.rows[0]?.exists || false

        if (tableCreatedByPgVector) {
          console.log(`[向量服务] 使用 pgVector.createIndex() 在 ${this.schemaName} schema 中创建表成功`)
        } else {
          // 检查表是否在其他 schema 中创建（比如 public）
          const allSchemaCheck = await client.query(
            `SELECT table_schema 
             FROM information_schema.tables 
             WHERE table_name = $1`,
            [indexName]
          )
          if (allSchemaCheck.rows.length > 0) {
            console.warn(
              `[向量服务] pgVector.createIndex() 在错误的 schema 中创建了表: ${allSchemaCheck.rows
                .map((r) => r.table_schema)
                .join(', ')}`
            )
            // 删除错误位置的表
            for (const row of allSchemaCheck.rows) {
              await client.query(`DROP TABLE IF EXISTS ${row.table_schema}.${indexName}`)
            }
          }
          console.warn(`[向量服务] pgVector.createIndex() 未在正确的 schema 中创建表，将手动创建`)
        }
      } catch (pgVectorError: any) {
        // 如果 pgVector.createIndex() 失败，手动创建符合 pgVector 期望的表结构
        console.warn(`[向量服务] pgVector.createIndex() 失败，手动创建表: ${pgVectorError.message}`)
      }

      // 如果 pgVector 没有在正确的 schema 中创建表，手动创建
      if (!tableCreatedByPgVector) {
        // pgVector 期望的表结构：vector_id (UUID 或 VARCHAR), embedding (vector), metadata (JSONB)
        await client.query(`
          CREATE TABLE IF NOT EXISTS ${this.schemaName}.${indexName} (
            vector_id VARCHAR(255) PRIMARY KEY,
            embedding vector(${dimension}),
            metadata JSONB
          )
        `)
        console.log(`[向量服务] 手动创建表 ${this.schemaName}.${indexName} 成功`)
      }

      // 创建向量索引（使用 HNSW 算法，适合大规模数据）
      try {
        await client.query(`
          CREATE INDEX IF NOT EXISTS ${indexName}_embedding_idx 
          ON ${this.schemaName}.${indexName} 
          USING hnsw (embedding vector_cosine_ops)
          WITH (m = 16, ef_construction = 64)
        `)
        console.log(`[向量服务] HNSW 索引创建成功`)
      } catch (idxError: any) {
        // 如果 HNSW 索引创建失败，尝试使用 ivfflat（需要先有数据）
        console.warn(`[向量服务] HNSW 索引创建失败，将在有数据后创建 ivfflat 索引: ${idxError.message}`)
        // 注意：ivfflat 索引需要先有数据才能创建，这里先不创建
      }

      // 验证表是否真的被创建
      const verifyCheck = await client.query(
        `SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = $1 
          AND table_name = $2
        )`,
        [this.schemaName, indexName]
      )
      const verified = verifyCheck.rows[0]?.exists
      console.log(`[向量服务] 验证表 ${this.schemaName}.${indexName} 是否存在: ${verified}`)

      if (!verified) {
        throw new Error(`Table ${this.schemaName}.${indexName} was not created`)
      }

      console.log(`[向量服务] 向量索引创建完成: ${this.schemaName}.${indexName}`)
    } catch (error: any) {
      console.error(`[向量服务] 创建索引失败: ${error.message}`)
      console.error(`[向量服务] 错误详情:`, error)
      throw error
    } finally {
      client.release()
    }
  }

  /**
   * 存储向量
   */
  async upsertVectors(
    knowledgeBaseId: string,
    vectors: number[][],
    metadata: Array<Record<string, any>>,
    ids?: string[]
  ): Promise<void> {
    const indexName = await this.getIndexName(knowledgeBaseId)
    await this.pgVector.upsert({
      indexName,
      vectors,
      metadata,
      ids
    })
  }

  /**
   * 查询向量
   * @param knowledgeBaseId 知识库ID
   * @param queryVector 查询向量
   * @param topK 返回结果数量
   * @param filter 元数据过滤条件（支持 MongoDB 风格查询语法）
   * @param pgVectorConfig pgVector 特定配置（ef, probes, minScore）
   */
  async query(
    knowledgeBaseId: string,
    queryVector: number[],
    topK: number = 10,
    filter?: Record<string, any>,
    pgVectorConfig?: { minScore?: number; ef?: number; probes?: number }
  ) {
    const indexName = await this.getIndexName(knowledgeBaseId)

    // 构建查询选项
    const queryOptions: any = {
      indexName,
      queryVector,
      topK,
      filter
    }

    // 如果提供了 pgVector 配置，直接透传给 PgVectorStore（ef, probes, minScore）
    if (pgVectorConfig) {
      if (pgVectorConfig.minScore !== undefined) queryOptions.minScore = pgVectorConfig.minScore
      if (pgVectorConfig.ef !== undefined) queryOptions.ef = pgVectorConfig.ef
      if (pgVectorConfig.probes !== undefined) queryOptions.probes = pgVectorConfig.probes
    }

    const results = await this.pgVector.query(queryOptions)

    // 如果指定了 minScore，在应用层也进行过滤（双重保障）
    // 注意：pgVector 的 minScore 可能在数据库层已过滤，但为了确保一致性，这里也过滤一次
    if (pgVectorConfig?.minScore !== undefined) {
      return results.filter((result: any) => (result.score || 0) >= pgVectorConfig.minScore!)
    }

    return results
  }

  /**
   * 纯元信息召回（metadata 检索，能力开关由调用方决定）：
   * 不走向量相似度，按 MongoDB 风格 metadata 条件匹配块；score 恒为 1（匹配即命中）。
   */
  async queryByMetadata(knowledgeBaseId: string, filter: Record<string, any>, topK: number = 10) {
    const indexName = await this.getIndexName(knowledgeBaseId)
    return this.pgVector.queryByMetadata({ indexName, filter, topK })
  }

  /**
   * 获取文档的所有向量ID（用于事务）
   * @param knowledgeBaseId 知识库ID
   * @param documentId 文档ID
   * @param client PostgreSQL客户端（可选，用于事务）
   * @returns 向量ID列表
   */
  async getDocumentVectorIds(knowledgeBaseId: string, documentId: string, client?: any): Promise<string[]> {
    const indexName = await this.getIndexName(knowledgeBaseId)
    const shouldReleaseClient = !client

    if (shouldReleaseClient) {
      client = await this.pool.connect()
    }

    try {
      await client.query(`SET search_path TO ${this.schemaName}, public`)

      const queryResult = await client.query(
        `SELECT vector_id as id
         FROM ${this.schemaName}.${indexName}
         WHERE metadata->>'documentId' = $1`,
        [documentId]
      )

      return queryResult.rows.map((row: any) => row.id)
    } finally {
      if (shouldReleaseClient && client) {
        client.release()
      }
    }
  }

  /**
   * 在事务中删除向量（使用外部提供的client）
   * @param knowledgeBaseId 知识库ID
   * @param vectorIds 向量ID列表
   * @param client PostgreSQL客户端（必须）
   */
  async deleteVectorsInTransaction(knowledgeBaseId: string, vectorIds: string[], client: any): Promise<void> {
    if (vectorIds.length === 0) return

    const indexName = await this.getIndexName(knowledgeBaseId)

    // 批量删除向量
    for (const vectorId of vectorIds) {
      try {
        await this.pgVector.deleteVector({
          indexName,
          id: vectorId
        })
      } catch (error: any) {
        // 如果向量不存在，忽略错误
        if (!error.message?.includes('not found')) {
          console.warn(`Failed to delete vector ${vectorId}:`, error.message)
        }
      }
    }
  }

  /**
   * 在事务中插入向量（使用外部提供的client）
   * 注意：PgVector的upsert不支持事务client，所以我们只能记录vectorIds
   * 真正的原子性需要在更高层次实现
   * @param knowledgeBaseId 知识库ID
   * @param vectors 向量列表
   * @param metadata 元数据列表
   * @param ids 向量ID列表（可选）
   * @returns 成功插入的向量ID列表（用于回滚）
   */
  async upsertVectorsInTransaction(
    knowledgeBaseId: string,
    vectors: number[][],
    metadata: Array<Record<string, any>>,
    ids?: string[]
  ): Promise<{ vectorIds: string[]; rollbackIds: string[] }> {
    const indexName = await this.getIndexName(knowledgeBaseId)

    // 获取当前的向量ID（如果有）
    const currentIds = ids || vectors.map((_, i) => `${Date.now()}_${i}`)

    try {
      // 调用 upsert（不支持事务，但这是pgvector的限制）
      await this.pgVector.upsert({
        indexName,
        vectors,
        metadata,
        ids: currentIds
      })

      return { vectorIds: currentIds, rollbackIds: [] }
    } catch (error: any) {
      // 如果失败，返回空列表表示没有插入成功
      return { vectorIds: [], rollbackIds: [] }
    }
  }

  /**
   * 根据文档ID删除向量
   * 优化：直接通过 SQL 查询 metadata，避免使用零向量进行低效的相似度查询
   */
  async deleteByDocumentId(knowledgeBaseId: string, documentId: string): Promise<void> {
    const indexName = await this.getIndexName(knowledgeBaseId)
    const client = await this.pool.connect()

    try {
      await client.query(`SET search_path TO ${this.schemaName}, public`)

      // 直接通过 metadata 查询所有相关的向量ID（高效方式）
      const queryResult = await client.query(
        `SELECT vector_id as id 
         FROM ${this.schemaName}.${indexName}
         WHERE metadata->>'documentId' = $1`,
        [documentId]
      )

      // 提取向量ID并删除
      if (queryResult.rows.length > 0) {
        const vectorIds = queryResult.rows.map((row) => row.id)
        await this.deleteBatch(knowledgeBaseId, vectorIds)
      }
    } finally {
      client.release()
    }
  }

  /**
   * 删除 database API 某一行对应的全部 chunk 向量（metadata.rowId）
   */
  async deleteByRowId(knowledgeBaseId: string, rowId: string): Promise<void> {
    const indexName = await this.getIndexName(knowledgeBaseId)
    const client = await this.pool.connect()

    try {
      await client.query(`SET search_path TO ${this.schemaName}, public`)

      const queryResult = await client.query(
        `SELECT vector_id as id 
         FROM ${this.schemaName}.${indexName}
         WHERE metadata->>'rowId' = $1`,
        [rowId]
      )

      if (queryResult.rows.length > 0) {
        const vectorIds = queryResult.rows.map((row) => row.id)
        await this.deleteBatch(knowledgeBaseId, vectorIds)
      }
    } finally {
      client.release()
    }
  }

  /**
   * 根据向量ID删除单个向量
   */
  async deleteByVectorId(knowledgeBaseId: string, vectorId: string): Promise<void> {
    await this.deleteBatch(knowledgeBaseId, [vectorId])
  }

  /**
   * 批量删除向量
   */
  async deleteBatch(knowledgeBaseId: string, vectorIds: string[]): Promise<void> {
    if (vectorIds.length === 0) return

    const indexName = await this.getIndexName(knowledgeBaseId)

    // PgVector 的 deleteVector 方法
    for (const vectorId of vectorIds) {
      try {
        await this.pgVector.deleteVector({
          indexName,
          id: vectorId
        })
      } catch (error: any) {
        // 如果向量不存在，忽略错误
        if (!error.message?.includes('not found')) {
          console.warn(`Failed to delete vector ${vectorId}:`, error.message)
        }
      }
    }
  }

  /**
   * 删除索引
   */
  async deleteIndex(knowledgeBaseId: string): Promise<void> {
    const indexName = await this.getIndexName(knowledgeBaseId)
    try {
      await this.pgVector.deleteIndex({
        indexName
      })
    } catch (error: any) {
      // 如果索引不存在，忽略错误
      if (!error.message?.includes('not found')) {
        throw error
      }
    }
  }

  /**
   * 根据文档ID获取所有chunks
   * 优化：直接通过 SQL 查询 metadata，避免使用零向量进行低效的相似度查询
   */
  async getChunksByDocumentId(knowledgeBaseId: string, documentId: string) {
    const indexName = await this.getIndexName(knowledgeBaseId)
    const client = await this.pool.connect()

    try {
      await client.query(`SET search_path TO ${this.schemaName}, public`)

      // 直接通过 metadata 查询所有相关的向量（高效方式）
      const queryResult = await client.query(
        `SELECT
          vector_id as id,
          metadata->>'text' as text,
          metadata,
          (metadata->>'chunkIndex')::integer as chunk_index
         FROM ${this.schemaName}.${indexName}
         WHERE metadata->>'documentId' = $1
         ORDER BY (metadata->>'chunkIndex')::integer ASC`,
        [documentId]
      )

      // 格式化结果
      const chunks = queryResult.rows.map((row) => {
        try {
          const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata
          return {
            id: row.id,
            text: row.text || '',
            chunkIndex: row.chunk_index ?? -1,
            metadata: metadata || {},
            documentId: metadata?.documentId || ''
          }
        } catch (parseError: any) {
          console.warn(`[VectorService] Failed to parse metadata for chunk ${row.id}:`, parseError.message)
          return {
            id: row.id,
            text: row.text || '',
            chunkIndex: row.chunk_index ?? -1,
            metadata: {},
            documentId: ''
          }
        }
      })

      console.log(`[VectorService] Retrieved ${chunks.length} chunks for document ${documentId}`)
      return chunks
    } catch (error: any) {
      console.error(`[VectorService] Failed to get chunks for document:`, {
        knowledgeBaseId,
        documentId,
        error: error.message,
        stack: error.stack
      })
      throw new Error(`Failed to get chunks for document ${documentId}: ${error.message}`)
    } finally {
      client.release()
    }
  }

  /**
   * 根据文档ID和chunkIndex获取单个chunk
   * 优化：直接SQL查询，避免查询所有后在内存中过滤
   */
  async getChunkByIndex(knowledgeBaseId: string, documentId: string, chunkIndex: number) {
    const indexName = await this.getIndexName(knowledgeBaseId)
    const client = await this.pool.connect()

    try {
      await client.query(`SET search_path TO ${this.schemaName}, public`)

      // 直接查询单个 chunk（性能优化：避免查询所有后过滤）
      const queryResult = await client.query(
        `SELECT
          vector_id as id,
          metadata->>'text' as text,
          metadata,
          (metadata->>'chunkIndex')::integer as chunk_index
         FROM ${this.schemaName}.${indexName}
         WHERE metadata->>'documentId' = $1
           AND (metadata->>'chunkIndex')::integer = $2
         LIMIT 1`,
        [documentId, chunkIndex]
      )

      if (queryResult.rows.length === 0) {
        return null
      }

      const row = queryResult.rows[0]
      const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata

      return {
        id: row.id,
        text: row.text || '',
        chunkIndex: row.chunk_index ?? -1,
        metadata: metadata || {},
        documentId: metadata?.documentId || ''
      }
    } catch (error: any) {
      console.error(`[VectorService] Failed to get chunk by index:`, {
        knowledgeBaseId,
        documentId,
        chunkIndex,
        error: error.message,
        stack: error.stack
      })
      throw new Error(`Failed to get chunk ${chunkIndex} for document ${documentId}: ${error.message}`)
    } finally {
      client.release()
    }
  }

  /**
   * 统计知识库的chunk数量
   */
  async countChunks(knowledgeBaseId: string): Promise<number> {
    const indexName = await this.getIndexName(knowledgeBaseId)
    const client = await this.pool.connect()

    try {
      await client.query(`SET search_path TO ${this.schemaName}, public`)

      // 先检查表是否存在
      const tableCheck = await client.query(
        `SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = $1
          AND table_name = $2
        )`,
        [this.schemaName, indexName]
      )

      const tableExists = tableCheck.rows[0]?.exists || false
      if (!tableExists) {
        console.warn(
          `[VectorService] Table ${this.schemaName}.${indexName} does not exist for knowledge base ${knowledgeBaseId}, returning 0`
        )
        return 0
      }

      const queryResult = await client.query(
        `SELECT COUNT(*) as total
         FROM ${this.schemaName}.${indexName}
         WHERE metadata->>'text' IS NOT NULL`
      )

      const count = parseInt(queryResult.rows[0]?.total || '0', 10)
      console.log(`[VectorService] Counted ${count} chunks for knowledge base ${knowledgeBaseId}`)
      return count
    } catch (error: any) {
      // 如果错误是表不存在，返回0而不是抛出错误
      if (error.message?.includes('does not exist') || error.message?.includes('relation')) {
        console.warn(
          `[VectorService] Table does not exist for knowledge base ${knowledgeBaseId}, returning 0: ${error.message}`
        )
        return 0
      }
      console.error(`[VectorService] Failed to count chunks:`, {
        knowledgeBaseId,
        error: error.message,
        stack: error.stack
      })
      throw new Error(`Failed to count chunks for knowledge base ${knowledgeBaseId}: ${error.message}`)
    } finally {
      client.release()
    }
  }

  /**
   * 获取知识库的所有chunks
   * 优化：直接通过 SQL 查询 metadata，支持分页和排序
   */
  async getAllChunksByKnowledgeBaseId(
    knowledgeBaseId: string,
    options?: {
      limit?: number
      offset?: number
      orderBy?: 'chunkIndex' | 'documentId' | 'createdAt'
      orderDirection?: 'ASC' | 'DESC'
    }
  ) {
    const indexName = await this.getIndexName(knowledgeBaseId)
    const client = await this.pool.connect()

    try {
      await client.query(`SET search_path TO ${this.schemaName}, public`)

      const limit = options?.limit || 1000
      const offset = options?.offset || 0
      const orderBy = options?.orderBy || 'chunkIndex'
      const orderDirection = options?.orderDirection || 'ASC'

      // 构建排序字段（白名单验证，防止SQL注入）
      let orderByField = ''
      if (orderBy === 'chunkIndex') {
        orderByField = `(metadata->>'chunkIndex')::integer`
      } else if (orderBy === 'documentId') {
        orderByField = `metadata->>'documentId'`
      } else {
        orderByField = `(metadata->>'chunkIndex')::integer`
      }

      // 验证 orderDirection（白名单验证，防止SQL注入）
      const validDirection = orderDirection === 'ASC' || orderDirection === 'DESC' ? orderDirection : 'ASC'

      // 直接通过 metadata 查询所有向量（高效方式）
      const queryResult = await client.query(
        `SELECT
          vector_id as id,
          metadata->>'text' as text,
          metadata,
          (metadata->>'chunkIndex')::integer as chunk_index
         FROM ${this.schemaName}.${indexName}
         WHERE metadata->>'text' IS NOT NULL
         ORDER BY ${orderByField} ${validDirection}
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      )

      // 获取总数
      const countResult = await client.query(
        `SELECT COUNT(*) as total
         FROM ${this.schemaName}.${indexName}
         WHERE metadata->>'text' IS NOT NULL`
      )
      const total = parseInt(countResult.rows[0]?.total || '0', 10)

      // 格式化结果（添加错误处理）
      const chunks = queryResult.rows.map((row) => {
        try {
          const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata
          return {
            id: row.id,
            text: row.text || '',
            chunkIndex: row.chunk_index ?? -1,
            metadata: metadata || {},
            documentId: metadata?.documentId || ''
          }
        } catch (parseError: any) {
          console.warn(`[VectorService] Failed to parse metadata for chunk ${row.id}:`, parseError.message)
          return {
            id: row.id,
            text: row.text || '',
            chunkIndex: row.chunk_index ?? -1,
            metadata: {},
            documentId: ''
          }
        }
      })

      console.log(
        `[VectorService] Retrieved ${chunks.length} chunks (total: ${total}) for knowledge base ${knowledgeBaseId}`
      )

      return {
        chunks,
        total,
        limit,
        offset,
        hasMore: offset + chunks.length < total
      }
    } catch (error: any) {
      console.error(`[VectorService] Failed to get all chunks for knowledge base:`, {
        knowledgeBaseId,
        options,
        error: error.message,
        stack: error.stack
      })
      throw new Error(`Failed to get chunks for knowledge base ${knowledgeBaseId}: ${error.message}`)
    } finally {
      client.release()
    }
  }

  /**
   * 获取索引名称
   */
  private async getIndexName(knowledgeBaseId: string): Promise<string> {
    // 检查缓存
    if (this.indexNameCache.has(knowledgeBaseId)) {
      return this.indexNameCache.get(knowledgeBaseId)!
    }

    // 仅从 knowledge_bases 读取；关系型数据集的物理表名由 database API 在调用前通过 primeIndexNameCache 注入
    let indexName: string | null = null
    try {
      const client = await this.pool.connect()
      try {
        await client.query(`SET search_path TO ${this.schemaName}, public`)
        const result = await client.query(`SELECT index_name FROM ${this.schemaName}.knowledge_bases WHERE id = $1`, [
          knowledgeBaseId
        ])
        if (result.rows.length > 0 && result.rows[0].index_name) {
          indexName = result.rows[0].index_name
        }
      } finally {
        client.release()
      }
    } catch (error) {
      // 如果获取失败，回退到计算方式
      console.warn(`Failed to get indexName from knowledge base ${knowledgeBaseId}, using computed name:`, error)
    }

    // 如果没有存储的 indexName，则计算
    const finalIndexName = indexName || getKnowledgeBaseIndexName(knowledgeBaseId)

    // 缓存结果
    this.indexNameCache.set(knowledgeBaseId, finalIndexName)

    return finalIndexName
  }

  /**
   * 由 database API 等在调用向量接口前注入物理表名，避免本服务查询其它业务域表。
   */
  primeIndexNameCache(datasetId: string, indexName: string): void {
    this.indexNameCache.set(datasetId, indexName)
  }
}
