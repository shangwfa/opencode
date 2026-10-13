import type { Pool, PoolClient, QueryResult } from 'pg'
import type { RowSchema, RowData, RowFilter, RowFieldValue } from './schema.js'
import { defaultEmbedFn } from '../extraction/index.js'
import { validateRow, rowToText } from './schema.js'
import { randomUUID } from 'crypto'

export interface RowRecord {
  id: string
  schemaName: string
  data: RowData
  source: string | null
  createdAt: Date
}

export interface UpsertRowsOptions {
  /** 溯源标识（对标 ExtractedObject.source_span 的轻量版） */
  source?: string
  /** 行文本嵌入函数；提供后写入行向量供语义检索 */
  embedFn?: (texts: string[]) => Promise<number[][]>
}

export interface RowQueryOptions {
  limit?: number
  offset?: number
}

/**
 * PG 行存储适配器（对标 TrustGraph rows-write-cassandra，PG 特化实现）
 *
 * 与 TrustGraph 的语义对齐：
 * - schema_name 对应 RowSchema.name，多 schema 共存一张表
 * - source 溯源列对应 ExtractedObject.source_span
 * - 行向量列对应 Qdrant 行嵌入（PG 内用 pgvector，无需独立向量库）
 *
 * 与 TrustGraph 的实现差异（PG 特化）：
 * - 不做"每索引字段一份行拷贝"（那是 Cassandra 分区键直查的代价换法），
 *   PG 用 jsonb + GIN 索引 + 参数化条件即可高效过滤
 * - 过滤字段白名单校验（必须为 schema 中 queryIndex 字段），对齐
 *   TrustGraph 动态 GraphQL 的"schema 约束查询面"安全语义
 */
export class PgRowStore {
  private pool: Pool
  private schemaName: string
  private embeddingDimension: number
  private schemas = new Map<string, RowSchema>()
  private vectorAvailable: boolean | null = null

  /** 内置默认嵌入（缺省 openai embedding 走代理），终端用户零配置 */
  private defaultEmbedFn: ((texts: string[]) => Promise<number[][]>) | null = null

  constructor(
    pool: Pool,
    schemaName: string,
    embeddingDimension = 1536,
    embedFn?: (texts: string[]) => Promise<number[][]>
  ) {
    this.pool = pool
    this.schemaName = schemaName
    this.embeddingDimension = embeddingDimension
    this.defaultEmbedFn = embedFn ?? null
  }

  /** 注册 schema（内存注册表，供 NL 查询的 schema-selection 使用） */
  registerSchema(schema: RowSchema): void {
    this.schemas.set(schema.name, schema)
  }

  getSchema(name: string): RowSchema | undefined {
    return this.schemas.get(name)
  }

  listSchemas(): RowSchema[] {
    return [...this.schemas.values()]
  }

  async init(): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query(`CREATE TABLE IF NOT EXISTS ${this.tableName()} (
        id TEXT PRIMARY KEY,
        schema_name TEXT NOT NULL,
        data JSONB NOT NULL,
        source TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`)
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_rows_data_schema ON ${this.tableName()} (schema_name)`
      )
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_rows_data_gin ON ${this.tableName()} USING GIN (data)`
      )

      // 行向量列（对标 Qdrant 行嵌入集合；pgvector 不可用时降级为纯过滤查询）
      try {
        await client.query(`CREATE EXTENSION IF NOT EXISTS vector SCHEMA public`)
        const col = await client.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = $1 AND table_name = 'rows_data' AND column_name = 'embedding'`,
          [this.schemaName]
        )
        if (col.rowCount === 0) {
          await client.query(
            `ALTER TABLE ${this.tableName()} ADD COLUMN embedding vector(${this.embeddingDimension})`
          )
        }
        this.vectorAvailable = true
      } catch (err: any) {
        this.vectorAvailable = false
        console.warn(`[行存储] 向量列创建失败（降级为纯过滤查询）: ${err.message}`)
      }

      // ivfflat 索引不能建在空表上：失败仅降级为顺序扫描，不影响向量可用性
      try {
        await client.query(
          `CREATE INDEX IF NOT EXISTS idx_rows_embedding
           ON ${this.tableName()} USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)`
        )
      } catch (idxError: any) {
        console.warn(`[行存储] ivfflat 索引创建失败（有数据后自动可用）: ${idxError.message}`)
      }
    } finally {
      client.release()
    }
  }

  private tableName(): string {
    return `${this.schemaName}.rows_data`
  }

  /**
   * 批量写入行（schema 校验 → 行文本嵌入 → upsert）
   * 校验失败的行跳过并告警，不中断整批
   */
  async upsertRows(
    schema: RowSchema,
    rows: RowData[],
    opts?: UpsertRowsOptions
  ): Promise<string[]> {
    this.registerSchema(schema)
    const validRows: RowData[] = []
    for (const row of rows) {
      const violations = validateRow(schema, row)
      if (violations.length > 0) {
        console.warn(`[行存储] 跳过未通过校验的行（${schema.name}）: ${violations.join('; ')}`)
        continue
      }
      validRows.push(row)
    }
    if (validRows.length === 0) return []

    let embeddings: number[][] | undefined
    // 终端用户零配置：未注入 embedFn 时使用内置真实嵌入（defaultEmbedFn 是工厂，需先调用）
    const embedFn = opts?.embedFn ?? this.defaultEmbedFn ?? (await defaultEmbedFn())
    if (embedFn && this.vectorAvailable !== false) {
      try {
        embeddings = await embedFn(validRows.map((r) => rowToText(schema, r)))
      } catch (err: any) {
        console.warn(`[行存储] 行嵌入失败（降级无向量写入）: ${err.message}`)
      }
    }

    const client: PoolClient = await this.pool.connect()
    const ids: string[] = []
    try {
      for (let i = 0; i < validRows.length; i++) {
        const id = rowIdOf(schema, validRows[i])
        ids.push(id)
        await client.query(
          `INSERT INTO ${this.tableName()} (id, schema_name, data, source, embedding, created_at)
           VALUES ($1, $2, $3::jsonb, $4, $5::vector, NOW())
           ON CONFLICT (id) DO UPDATE SET
             data = EXCLUDED.data,
             source = EXCLUDED.source,
             embedding = COALESCE(EXCLUDED.embedding, ${this.schemaName}.rows_data.embedding)`,
          [
            id,
            schema.name,
            JSON.stringify(validRows[i]),
            opts?.source ?? null,
            embeddings?.[i] ? JSON.stringify(embeddings[i]) : null,
          ]
        )
      }
    } finally {
      client.release()
    }
    return ids
  }

  /** 精确过滤查询（字段白名单 + 参数化，防注入面） */
  async queryRows(schema: RowSchema, filters?: RowFilter[], options?: RowQueryOptions): Promise<RowRecord[]> {
    const { where, params } = this.buildFilterClause(schema, filters)
    const limit = options?.limit ?? 50
    const offset = options?.offset ?? 0

    const result: QueryResult = await this.pool.query(
      `SELECT id, schema_name, data, source, created_at
       FROM ${this.tableName()}
       WHERE schema_name = $1 ${where}
       ORDER BY created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      [schema.name, ...params]
    )
    return result.rows.map(mapRow)
  }

  /** 语义检索（对标 row-embeddings-query：查询向量 ANN + 可选过滤） */
  async searchSemantic(
    schema: RowSchema,
    queryEmbedding: number[],
    filters?: RowFilter[],
    limit = 10
  ): Promise<Array<{ record: RowRecord; score: number }>> {
    if (this.vectorAvailable === false) {
      throw new Error('行向量不可用（pgvector 未启用），语义检索不可用')
    }
    const { where, params } = this.buildFilterClause(schema, filters)

    const result: QueryResult = await this.pool.query(
      `SELECT id, schema_name, data, source, created_at,
              1 - (embedding <=> $2::vector) AS score
       FROM ${this.tableName()}
       WHERE schema_name = $1 AND embedding IS NOT NULL ${where}
       ORDER BY embedding <=> $2::vector
       LIMIT ${limit}`,
      [schema.name, JSON.stringify(queryEmbedding), ...params]
    )
    return result.rows.map((r) => ({ record: mapRow(r), score: Number(r.score) }))
  }

  async deleteBySchema(schemaName: string): Promise<void> {
    await this.pool.query(`DELETE FROM ${this.tableName()} WHERE schema_name = $1`, [schemaName])
  }

  async count(schemaName?: string): Promise<number> {
    const result: QueryResult = schemaName
      ? await this.pool.query(`SELECT COUNT(*) AS c FROM ${this.tableName()} WHERE schema_name = $1`, [schemaName])
      : await this.pool.query(`SELECT COUNT(*) AS c FROM ${this.tableName()}`)
    return Number(result.rows[0]?.c ?? 0)
  }

  /** 过滤条件 → 参数化 SQL WHERE 片段（字段白名单校验） */
  private buildFilterClause(
    schema: RowSchema,
    filters?: RowFilter[]
  ): { where: string; params: RowFieldValue[] } {
    if (!filters || filters.length === 0) return { where: '', params: [] }

    const indexable = new Map(schema.fields.filter((f) => f.queryIndex).map((f) => [f.name, f]))
    const clauses: string[] = []
    const params: RowFieldValue[] = []

    for (const filter of filters) {
      const field = indexable.get(filter.field)
      if (!field) {
        console.warn(`[行存储] 过滤字段 "${filter.field}" 不是 ${schema.name} 的可索引字段，已跳过`)
        continue
      }
      // in 的值在分支内逐个 push，主 push 跳过（避免整个数组被字符串化）
      if (filter.op !== 'in') {
        params.push(this.castValue(field.type, filter.value as RowFieldValue))
      }
      const pIdx = `$${params.length + 1}` // $1 留给 schema_name
      const escaped = escapeIdent(filter.field)
      // 数字/日期列 cast 后比较，避免文本序陷阱（'10' < '3'）
      const jsonRef =
        field.type === 'number'
          ? `(data->>'${escaped}')::numeric`
          : field.type === 'date'
            ? `(data->>'${escaped}')::timestamptz`
            : `data->>'${escaped}'`

      switch (filter.op) {
        case 'eq':
          clauses.push(`${jsonRef} = ${pIdx}`)
          break
        case 'ne':
          clauses.push(`${jsonRef} <> ${pIdx}`)
          break
        case 'gt':
          clauses.push(`${jsonRef} > ${pIdx}`)
          break
        case 'gte':
          clauses.push(`${jsonRef} >= ${pIdx}`)
          break
        case 'lt':
          clauses.push(`${jsonRef} < ${pIdx}`)
          break
        case 'lte':
          clauses.push(`${jsonRef} <= ${pIdx}`)
          break
        case 'contains':
          clauses.push(`${jsonRef} ILIKE '%' || ${pIdx} || '%'`)
          break
        case 'in': {
          const values = (filter.value as RowFieldValue[]).map((v) => {
            params.push(this.castValue(field.type, v))
            return `$${params.length + 1}`
          })
          clauses.push(`${jsonRef} IN (${values.join(', ')})`)
          break
        }
        default:
          throw new Error(`不支持的过滤操作符: ${String(filter.op)}`)
      }
    }

    return { where: clauses.length > 0 ? `AND ${clauses.join(' AND ')}` : '', params }
  }

  private castValue(type: string, value: RowFieldValue): string {
    if (value === null) return ''
    return type === 'date' || type === 'number' || type === 'boolean' ? String(value) : String(value)
  }
}

function rowIdOf(schema: RowSchema, row: RowData): string {
  const primary = schema.fields.find((f) => f.primary)
  if (primary && row[primary.name] !== undefined && row[primary.name] !== null) {
    return `${schema.name}:${row[primary.name]}`
  }
  return `${schema.name}:${randomUUID()}`
}

function mapRow(r: Record<string, unknown>): RowRecord {
  return {
    id: String(r.id),
    schemaName: String(r.schema_name),
    data: (typeof r.data === 'string' ? JSON.parse(r.data) : r.data) as RowData,
    source: (r.source as string | null) ?? null,
    createdAt: new Date(r.created_at as string),
  }
}

function escapeIdent(name: string): string {
  return name.replace(/'/g, "''")
}
