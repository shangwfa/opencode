/**
 * pgvector 向量存储（替代 @mastra/pg 的 PgVector，去除 mastra 依赖）。
 *
 * 表结构与原实现保持兼容：
 *   <schema>.<indexName> (
 *     vector_id VARCHAR(255) PRIMARY KEY,
 *     embedding vector(dim),
 *     metadata JSONB
 *   )
 * 相似度：1 - (embedding <=> query)，cosine 距离；HNSW 索引 vector_cosine_ops。
 */
import { Pool, type PoolClient } from "pg"
import { randomUUID } from "node:crypto"
import { buildDeleteFilterQuery, buildFilterQuery } from "./filter.js"

export interface VectorRecord {
  id: string
  score: number
  metadata: Record<string, any>
  vector?: number[]
}

export interface QueryOptions {
  indexName: string
  queryVector: number[]
  topK?: number
  filter?: Record<string, any>
  includeVector?: boolean
  minScore?: number
  ef?: number
  probes?: number
}

export interface UpsertOptions {
  indexName: string
  vectors: number[][]
  metadata: Array<Record<string, any>>
  ids?: string[]
  deleteFilter?: Record<string, any>
}

export interface CreateIndexOptions {
  indexName: string
  dimension: number
  metric?: "cosine" | "euclidean" | "dotproduct"
}

/** SQL 标识符安全校验（防注入；标识符不走参数化） */
export function parseSqlIdentifier(name: string, kind: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid ${kind}: ${name}`)
  }
  return name
}

export class PgVectorStore {
  private pool: Pool
  private schema: string
  private ensuredSchemas = new Set<string>()

  constructor(options: { connectionString: string; schemaName: string }) {
    this.pool = new Pool({ connectionString: options.connectionString })
    this.schema = options.schemaName
    parseSqlIdentifier(this.schema, "schema name")
  }

  /** 复用外部连接池（与业务表共享事务时使用） */
  static fromPool(pool: Pool, schemaName: string): PgVectorStore {
    const store = Object.create(PgVectorStore.prototype) as PgVectorStore
    store.pool = pool
    store.schema = schemaName
    store.ensuredSchemas = new Set()
    parseSqlIdentifier(store.schema, "schema name")
    return store
  }

  async close(): Promise<void> {
    await this.pool.end()
  }

  private tableName(indexName: string): string {
    return `"${this.schema}"."${parseSqlIdentifier(indexName, "index name")}"`
  }

  private async ensureEnvironment(client: PoolClient): Promise<void> {
    if (this.ensuredSchemas.has(this.schema)) return
    try {
      await client.query(`CREATE SCHEMA IF NOT EXISTS "${this.schema}"`)
    } catch (error: any) {
      // 并发初始化时 CREATE SCHEMA IF NOT EXISTS 可能报 duplicate key（pg_namespace 竞态），schema 存在即为成功
      if (error.code !== "23505" && error.code !== "42P06") throw error
    }
    try {
      await client.query(`CREATE EXTENSION IF NOT EXISTS vector SCHEMA public`)
    } catch (error: any) {
      // 区分「扩展未安装」与「已存在/权限问题」：前者 fail-fast 给出安装指引，避免建表时报模糊的 type "vector" does not exist
      const available = await client
        .query(`SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`)
        .catch(() => ({ rows: [] as unknown[] }))
      if (!available.rows || available.rows.length === 0) {
        throw new Error(
          `pgvector 扩展不可用：向量检索依赖 PostgreSQL 扩展 "vector"。` +
            `请在数据库服务器安装 pgvector（docker 镜像 pgvector/pgvector:pg16；Homebrew: brew install pgvector）后重试。` +
            `原始错误: ${error.message}`,
        )
      }
      console.warn(`[vector] pgvector 扩展创建失败（可能权限不足，假设已由 DBA 安装）: ${error.message}`)
    }
    this.ensuredSchemas.add(this.schema)
  }

  /**
   * 创建向量表与 HNSW 索引（幂等）。表已存在但缺 vector_id 列时删除重建。
   */
  async createIndex(options: CreateIndexOptions): Promise<void> {
    const { dimension } = options
    const indexName = parseSqlIdentifier(options.indexName, "index name")
    const table = this.tableName(indexName)
    const client = await this.pool.connect()
    try {
      await this.ensureEnvironment(client)

      const columnCheck = await client.query(
        `SELECT column_name FROM information_schema.columns 
         WHERE table_schema = $1 AND table_name = $2 AND column_name = 'vector_id'`,
        [this.schema, indexName],
      )
      if (columnCheck.rows.length === 0) {
        await client.query(`DROP TABLE IF EXISTS ${table}`)
      }

      await client.query(`
        CREATE TABLE IF NOT EXISTS ${table} (
          vector_id VARCHAR(255) PRIMARY KEY,
          embedding vector(${dimension}),
          metadata JSONB
        )
      `)

      try {
        await client.query(`
          CREATE INDEX IF NOT EXISTS "${indexName}_embedding_idx" 
          ON ${table} 
          USING hnsw (embedding vector_cosine_ops)
          WITH (m = 16, ef_construction = 64)
        `)
      } catch (idxError: any) {
        console.warn(`[vector] HNSW 索引创建失败: ${idxError.message}`)
      }
    } finally {
      client.release()
    }
  }

  async upsert(options: UpsertOptions): Promise<string[]> {
    const table = this.tableName(options.indexName)
    const { vectors, metadata, ids } = options
    const vectorIds = ids || vectors.map(() => randomUUID())
    const client = await this.pool.connect()
    try {
      await client.query("BEGIN")
      if (options.deleteFilter) {
        const { sql, values } = buildDeleteFilterQuery(options.deleteFilter)
        const whereClause = sql.trim().replace(/^WHERE\s+/i, "")
        if (whereClause) {
          await client.query(`DELETE FROM ${table} WHERE ${whereClause}`, values)
        }
      }
      for (let i = 0; i < vectors.length; i++) {
        await client.query(
          `INSERT INTO ${table} (vector_id, embedding, metadata)
           VALUES ($1, $2::vector, $3::jsonb)
           ON CONFLICT (vector_id)
           DO UPDATE SET embedding = $2::vector, metadata = $3::jsonb`,
          [vectorIds[i], `[${vectors[i]?.join(",")}]`, JSON.stringify(metadata?.[i] || {})],
        )
      }
      await client.query("COMMIT")
      return vectorIds as string[]
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  }

  /**
   * 纯元信息召回（metadata 检索）：不计算向量相似度，仅按 MongoDB 风格 metadata 条件匹配。
   * 能力由调用方决定是否使用（searchType='metadata'）；score 恒为 1（匹配即命中，无相似度语义），
   * 排序按 metadata.syncedAt 倒序（同批内容内按 chunkIndex 正序）保证稳定。
   */
  async queryByMetadata(options: {
    indexName: string
    filter: Record<string, any>
    topK?: number
  }): Promise<VectorRecord[]> {
    const { indexName, filter, topK = 10 } = options
    if (!filter || Object.keys(filter).length === 0) {
      throw new Error("metadata search requires a non-empty filter")
    }
    if (!Number.isInteger(topK) || topK <= 0) {
      throw new Error("topK must be a positive integer")
    }
    const table = this.tableName(indexName)
    const { sql: filterSql, values } = buildDeleteFilterQuery(filter)
    const conditions = filterSql.replace(/^WHERE /, "") || "TRUE"
    const limitIndex = values.length + 1
    const query = `
      SELECT vector_id as id, metadata
      FROM ${table}
      WHERE ${conditions}
      ORDER BY (metadata#>>'{syncedAt}') DESC NULLS LAST, (metadata#>>'{chunkIndex}') ASC NULLS LAST
      LIMIT $${limitIndex}`
    const result = await this.pool.query(query, [...values, topK])
    return result.rows.map(({ id, metadata }: any) => ({ id, score: 1, metadata }))
  }

  async query(options: QueryOptions): Promise<VectorRecord[]> {
    const { queryVector, topK = 10, filter, includeVector = false, minScore = -1, ef, probes } = options
    if (!Number.isInteger(topK) || topK <= 0) {
      throw new Error("topK must be a positive integer")
    }
    if (!Array.isArray(queryVector) || !queryVector.every((x) => typeof x === "number" && Number.isFinite(x))) {
      throw new Error("queryVector must be an array of finite numbers")
    }
    const table = this.tableName(options.indexName)
    const vectorStr = `[${queryVector.join(",")}]`
    const { sql: filterQuery, values } = buildFilterQuery(filter, minScore, topK)
    const client = await this.pool.connect()
    try {
      await client.query("BEGIN")
      if (ef !== undefined) {
        const searchEf = Math.min(1000, Math.max(1, Math.floor(ef)))
        await client.query(`SET LOCAL hnsw.ef_search = ${searchEf}`)
      }
      if (probes !== undefined) {
        const searchProbes = Math.max(1, Math.floor(probes))
        await client.query(`SET LOCAL ivfflat.probes = ${searchProbes}`)
      }
      const query = `
        WITH vector_scores AS (
          SELECT
            vector_id as id,
            1 - (embedding <=> '${vectorStr}'::vector) as score,
            metadata
            ${includeVector ? ", embedding" : ""}
          FROM ${table}
          ${filterQuery}
        )
        SELECT *
        FROM vector_scores
        WHERE score > $1
        ORDER BY score DESC
        LIMIT $2`
      const result = await client.query(query, values)
      await client.query("COMMIT")
      return result.rows.map(({ id, score, metadata, embedding }: any) => ({
        id,
        score,
        metadata,
        ...(includeVector && embedding ? { vector: JSON.parse(embedding) } : {}),
      }))
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  }

  async deleteVector(options: { indexName: string; id: string }): Promise<void> {
    const table = this.tableName(options.indexName)
    await this.pool.query(`DELETE FROM ${table} WHERE vector_id = $1`, [options.id])
  }

  async deleteIndex(options: { indexName: string }): Promise<void> {
    const table = this.tableName(options.indexName)
    await this.pool.query(`DROP TABLE IF EXISTS ${table}`)
  }
}
