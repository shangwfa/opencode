import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { embedMany } from 'ai'
import { eq, desc, or, ilike, asc, sql } from 'drizzle-orm'
import { VectorService } from '../../rag/knowledge-base/index.js'
import { DocumentService } from '../../rag/knowledge-base/index.js'
import { createEmbeddingModel, generateQueryEmbedding } from '../../utils/search-helper.js'
import { db, databaseBases, schemaName, pool } from '../db/index.js'
import { getKnowledgeBaseIndexName, normalizeIndexName } from '../../utils/index-name.js'
import type {
  BatchRowsDeleteRequest,
  BatchRowsUpdateRequest,
  CreateDatabaseRequest,
  DatabaseColumnDefinition,
  DatabaseDefinition,
  UpdateDatabaseRequest
} from '../types/database.types'
import { ROWS_SEARCH_MAX_FILTER_LIMIT } from '../types/database.types'
import type { ChunkStrategy, SearchResultItem } from '../../rag/knowledge-base/index.js'
import { keywordSearchService } from '../../rag/knowledge-base/index.js'

/** 单次 embedMany + pg upsert，降低大请求耗时与内存峰值 */
const EMBEDDING_UPSERT_BATCH_SIZE = 64
/** 并行调用分块（本地 CPU），避免串行过慢 */
const CHUNK_TEXT_BUILD_CONCURRENCY = 8
/** 动态表批量 INSERT 行数，减少 DB 往返 */
const PHYSICAL_INSERT_BATCH_SIZE = 100

function getEmbeddingDimension(): number {
  return 1536
}

function physicalDataTableName(datasetId: string): string {
  const n = normalizeIndexName(datasetId.replace(/^rd_/, ''))
  let name = `rd_tbl_${n}`
  if (name.length > 63) {
    const h = createHash('sha256').update(datasetId).digest('hex').slice(0, 16)
    name = `rd_tbl_${h}`
  }
  return name
}

function assertSafeIdentifier(name: string): void {
  if (!/^[a-zA-Z][a-zA-Z0-9_]{0,62}$/.test(name)) {
    throw new Error(`Invalid identifier: ${name}`)
  }
}

/** ILIKE 通配符转义（配合 ESCAPE '\'） */
function escapeILikePattern(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

function buildRowsFilterWhere(
  meta: DatabaseDefinition,
  filter: Record<string, unknown>,
  startIndex = 1
): { whereClause: string; params: unknown[] } {
  const colNames = meta.columnDefinitions.map((c) => c.name).filter(Boolean)
  const allowed = new Set<string>(['id', ...colNames])

  const keys = Object.keys(filter).sort()
  if (keys.length === 0) {
    throw new Error('Filter object must contain at least one key')
  }

  const parts: string[] = []
  const params: unknown[] = []
  let i = startIndex

  for (const k of keys) {
    if (!allowed.has(k)) {
      throw new Error(`Unknown filter key: ${k}. Allowed: ${[...allowed].join(', ')}`)
    }
    assertSafeIdentifier(k)
    const v = filter[k]
    if (v === null) {
      parts.push(`"${k}" IS NULL`)
      continue
    }
    if (typeof v === 'object' && v !== null) {
      throw new Error(`Unsupported value type for "${k}": use string, number, boolean, or null`)
    }

    if (k === 'id') {
      parts.push(`"${k}" = $${i++}`)
      params.push(String(v))
      continue
    }

    // TEXT 业务列：子串匹配 + 去空格，兼容「浙江」搜「浙江省」、前后空格
    if (typeof v === 'string') {
      const trimmed = v.trim()
      if (trimmed === '') {
        throw new Error(`Filter value for "${k}" cannot be empty or whitespace-only`)
      }
      parts.push(`trim("${k}"::text) ILIKE $${i++} ESCAPE '\\'`)
      params.push(`%${escapeILikePattern(trimmed)}%`)
      continue
    }

    const asText = String(v)
    parts.push(`trim("${k}"::text) = $${i++}`)
    params.push(asText)
  }

  return { whereClause: parts.join(' AND '), params }
}

export class DatabaseService {
  constructor(
    private vectorService: VectorService,
    private documentService: DocumentService
  ) {}

  /** chunk 向量 id：与行 id 区分，避免与旧版「单行一向量 id=行 id」冲突 */
  private static rowChunkVectorId(rowId: string, chunkIndex: number): string {
    return `${rowId}__c${chunkIndex}`
  }

  /** 从检索结果解析所属行 id（chunk 向量或旧版单行向量）；field 向量 id 形如 <rowId>__f_<col>__c<i> */
  private resolveRowIdFromVectorId(id: string, metadata?: Record<string, unknown>): string {
    const md = metadata || {}
    if (md.rowId != null && String(md.rowId).length > 0) {
      return String(md.rowId)
    }
    const s = String(id)
    const m = /^(.+?)__(?:f_[A-Za-z0-9_]+__)?c(\d+)$/.exec(s)
    if (m) return m[1]
    return s
  }

  private mapSqlType(col: DatabaseColumnDefinition): string {
    return 'TEXT';
  }

  private async createPhysicalTable(dataTableName: string, columns: DatabaseColumnDefinition[]): Promise<void> {
    assertSafeIdentifier(dataTableName)
    for (const c of columns) {
      assertSafeIdentifier(c.name)
    }

    const dynamicCols = columns
      .map((c) => {
        const t = this.mapSqlType(c)
        const nn = c.notNull ? ' NOT NULL' : ''
        // 列名加引号：columnNameRegex 允许 desc/order 等 PG 保留字
        return `"${c.name}" ${t}${nn}`
      })
      .join(',\n  ')

    const ddl = `
CREATE TABLE IF NOT EXISTS ${schemaName}.${dataTableName} (
  id VARCHAR(255) PRIMARY KEY,
  ${dynamicCols},
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
)`
    const client = await pool.connect()
    try {
      await client.query(`SET search_path TO ${schemaName}, public`)
      await client.query(ddl)
    } finally {
      client.release()
    }
  }

  private async dropPhysicalTable(dataTableName: string): Promise<void> {
    assertSafeIdentifier(dataTableName)
    const client = await pool.connect()
    try {
      await client.query(`SET search_path TO ${schemaName}, public`)
      await client.query(`DROP TABLE IF EXISTS ${schemaName}.${dataTableName}`)
    } finally {
      client.release()
    }
  }

  async createDatabase(request: CreateDatabaseRequest): Promise<DatabaseDefinition> {
    const id = request.id || `rd_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`
    const dataTableName = physicalDataTableName(id)
    const now = new Date()
    const defaultChunkConfig = { maxSize: 512, overlap: 50 }
    const indexName = getKnowledgeBaseIndexName(id)
    const indexDimension = getEmbeddingDimension()
    await this.assertIndexNameAvailable(id, indexName, dataTableName)

    const [inserted] = await db
      .insert(databaseBases)
      .values({
        id,
        name: request.name,
        description: request.description ?? null,
        embeddingModel: request.embeddingModel ?? 'openai/text-embedding-3-small',
        defaultChunkStrategy: request.defaultChunkStrategy ?? 'recursive',
        defaultChunkConfig: request.defaultChunkConfig ?? defaultChunkConfig,
        vectorStrategy: request.vectorStrategy ?? 'row',
        keyColumn: request.keyColumn ?? null,
        dataTableName,
        columnDefinitions: request.columns as unknown as Record<string, unknown>[],
        createdAt: now,
        updatedAt: now
      })
      .returning()

    if (!inserted) {
      throw new Error('Failed to create dataset registry row')
    }

    try {
      await this.createPhysicalTable(dataTableName, request.columns)
      if (request.keyColumn) {
        // 幂等键唯一约束：ON CONFLICT upsert 依赖该唯一索引；失败时删除本次新建的表，避免留下无注册的孤儿表
        assertSafeIdentifier(request.keyColumn)
        try {
          const client = await pool.connect()
          try {
            await client.query(`SET search_path TO ${schemaName}, public`)
            await client.query(
              `CREATE UNIQUE INDEX IF NOT EXISTS "${dataTableName}_key_uidx" ON ${schemaName}.${dataTableName} ("${request.keyColumn}")`
            )
          } finally {
            client.release()
          }
        } catch (indexError) {
          await this.dropPhysicalTable(dataTableName).catch(() => undefined)
          throw indexError
        }
      }
    } catch (e: any) {
      await db.delete(databaseBases).where(eq(databaseBases.id, id))
      throw new Error(`Failed to create dynamic table: ${e.message}`)
    }

    const indexCreatedAt = new Date()
    try {
      await this.vectorService.createIndex(id, indexDimension)
      await db
        .update(databaseBases)
        .set({
          indexName,
          indexDimension,
          indexCreated: 1,
          indexCreatedAt,
          updatedAt: indexCreatedAt
        })
        .where(eq(databaseBases.id, id))

      try {
        await keywordSearchService.createPerformanceIndexes(id)
        console.log(`Auto-created multilingual full-text search indexes for dataset: ${id}`)
      } catch (fullTextIndexError: any) {
        console.warn(`Failed to create full-text search indexes for ${id}:`, fullTextIndexError.message)
      }
    } catch (e: any) {
      await this.dropPhysicalTable(dataTableName)
      await db.delete(databaseBases).where(eq(databaseBases.id, id))
      throw new Error(`Failed to create vector index: ${e.message}`)
    }

    const full = await this.getDatabase(id)
    if (!full) {
      throw new Error('Failed to load dataset after create')
    }

    const initialRows = request.dataSource
    if (initialRows?.length) {
      try {
        await this.insertRowsFromMetadataBatch(id, initialRows)
      } catch (e: any) {
        try {
          await this.deleteDatabase(id)
        } catch (cleanupErr: unknown) {
          console.error('[createDatabase] cleanup after failed dataSource:', (cleanupErr as Error)?.message)
        }
        throw new Error(e?.message ? `Failed to import initial data: ${e.message}` : 'Failed to import initial data')
      }
    }

    return (await this.getDatabase(id, { includeStats: true })) ?? full
  }

  /**
   * 同步物理表结构：删列、加列、已有列 NOT NULL 变更（列类型当前均为 TEXT）
   */
  private async migratePhysicalTableColumns(
    dataTableName: string,
    oldCols: DatabaseColumnDefinition[],
    newCols: DatabaseColumnDefinition[],
    client: PoolClient
  ): Promise<void> {
    const oldMap = new Map(oldCols.map((c) => [c.name, c]))
    const oldNames = new Set(oldCols.map((c) => c.name))
    const newNames = new Set(newCols.map((c) => c.name))

    for (const name of oldNames) {
      if (!newNames.has(name)) {
        assertSafeIdentifier(name)
        await client.query(
          `ALTER TABLE ${schemaName}.${dataTableName} DROP COLUMN IF EXISTS "${name}"`
        )
      }
    }

    for (const col of newCols) {
      assertSafeIdentifier(col.name)
      if (oldNames.has(col.name)) continue

      const sqlType = this.mapSqlType(col)
      if (col.notNull) {
        await client.query(
          `ALTER TABLE ${schemaName}.${dataTableName} ADD COLUMN "${col.name}" ${sqlType} NOT NULL DEFAULT ''`
        )
      } else {
        await client.query(
          `ALTER TABLE ${schemaName}.${dataTableName} ADD COLUMN "${col.name}" ${sqlType}`
        )
      }
    }

    for (const col of newCols) {
      if (!oldNames.has(col.name)) continue
      const prev = oldMap.get(col.name)!
      if (prev.notNull === col.notNull) continue
      assertSafeIdentifier(col.name)
      if (col.notNull) {
        try {
          await client.query(
            `ALTER TABLE ${schemaName}.${dataTableName} ALTER COLUMN "${col.name}" SET NOT NULL`
          )
        } catch (e: any) {
          throw new Error(
            `Cannot set NOT NULL on "${col.name}": existing rows may contain NULL. ${e.message}`
          )
        }
      } else {
        await client.query(
          `ALTER TABLE ${schemaName}.${dataTableName} ALTER COLUMN "${col.name}" DROP NOT NULL`
        )
      }
    }
  }

  /**
   * 更新元数据中的 columns，并对 data_table_name 对应表执行 ALTER TABLE 迁移
   */
  async updateDatabase(id: string, request: UpdateDatabaseRequest): Promise<DatabaseDefinition> {
    const meta = await this.getDatabase(id)
    if (!meta) {
      throw new Error(`Dataset ${id} not found`)
    }

    const oldCols = meta.columnDefinitions
    const newCols = request.columns
    const newNames = new Set(newCols.map((c) => c.name))
    const hadRemovedColumns = oldCols.some((c) => !newNames.has(c.name))
    const strategyChanged = (request.vectorStrategy ?? meta.vectorStrategy ?? 'row') !== (meta.vectorStrategy ?? 'row')
    const dataTableName = meta.dataTableName
    assertSafeIdentifier(dataTableName)

    const nameVal = request.name !== undefined ? request.name : meta.name
    const descVal =
      request.description !== undefined ? request.description : (meta.description ?? null)
    const now = new Date()

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SET search_path TO ${schemaName}, public`)

      await this.migratePhysicalTableColumns(dataTableName, oldCols, newCols, client)

      await client.query(
        `UPDATE ${schemaName}.databases
         SET column_definitions = $1::jsonb, name = $2, description = $3, updated_at = $4,
             vector_strategy = COALESCE($6, vector_strategy)
         WHERE id = $5`,
        [JSON.stringify(newCols), nameVal, descVal, now, id, request.vectorStrategy ?? null]
      )

      await client.query('COMMIT')
    } catch (e: any) {
      try {
        await client.query('ROLLBACK')
      } catch {
        /* ignore */
      }
      throw new Error(e.message || 'Failed to update dataset')
    } finally {
      client.release()
    }

    const full = await this.getDatabase(id)
    if (!full) {
      throw new Error('Failed to load dataset after update')
    }

    if ((hadRemovedColumns || strategyChanged) && full.indexCreated) {
      await this.revectorizeAllRowsInDataset(id)
    }

    return full
  }

  private mapRow(r: typeof databaseBases.$inferSelect): DatabaseDefinition {
    const cols = (Array.isArray(r.columnDefinitions) ? r.columnDefinitions : []) as unknown as DatabaseColumnDefinition[]
    return {
      id: r.id,
      name: r.name,
      description: r.description || undefined,
      embeddingModel: r.embeddingModel,
      defaultChunkStrategy: r.defaultChunkStrategy as ChunkStrategy,
      defaultChunkConfig: r.defaultChunkConfig as any,
      indexName: r.indexName || undefined,
      indexDimension: r.indexDimension || undefined,
      indexCreated: r.indexCreated === 1,
      indexCreatedAt: r.indexCreatedAt || undefined,
      dataTableName: r.dataTableName,
      columnDefinitions: cols,
      vectorStrategy: ((r as any).vectorStrategy as DatabaseDefinition['vectorStrategy']) || 'row',
      keyColumn: ((r as any).keyColumn as string | null) || undefined,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt
    }
  }

  /**
   * 确定性字段级序列化（F05 修复）：字段名标签 + 换行边界。
   * 旧行为 join('') 无分隔导致跨字段粘连（"浙江省杭州市"+"企业版授权"）与数值粘连（5+45000→545000）。
   * 序列化格式变更后，存量数据集需重向量化才会与新写入一致。
   */
  private embeddingTextFromRecord(record: Record<string, unknown>, columns: DatabaseColumnDefinition[]): string {
    return columns
      .map((c) => {
        const v = record[c.name]
        if (v === null || v === undefined || String(v).trim() === '') return ''
        return `${c.name}: ${String(v)}`
      })
      .filter(Boolean)
      .join('\n')
  }

  /**
   * 按数据集向量化策略生成索引任务：
   * - row：整行序列化文本分块，每块一向量（id <rowId>__c<i>）
   * - field：每字段 "col: value" 独立向量化（id <rowId>__f_<col>__c<i>，metadata.field 标记）
   * - row+field：两者并存，向量 id 互不冲突
   */
  private async buildIndexTasks(
    datasetId: string,
    meta: Pick<DatabaseDefinition, 'vectorStrategy' | 'defaultChunkStrategy' | 'defaultChunkConfig' | 'columnDefinitions'>,
    rec: Record<string, unknown>,
    chunker?: Pick<DocumentService, 'chunkPlainText'>
  ): Promise<Array<{ rowId: string; field?: string; chunkIndex: number; text: string; vectorId: string }>> {
    const rowId = String(rec.id ?? '')
    if (!rowId) return []
    const columns = meta.columnDefinitions
    if (!columns.length) return []
    const chunkPlainText = chunker ? chunker.chunkPlainText.bind(chunker) : this.documentService.chunkPlainText.bind(this.documentService)
    const strategy = meta.vectorStrategy ?? 'row'

    const tasks: Array<{ rowId: string; field?: string; chunkIndex: number; text: string; vectorId: string }> = []
    const pushChunks = async (text: string, field?: string) => {
      if (!text.trim()) return
      const chunks = await chunkPlainText(text, meta.defaultChunkStrategy, meta.defaultChunkConfig)
      for (let i = 0; i < chunks.length; i++) {
        tasks.push({
          rowId,
          field,
          chunkIndex: i,
          text: chunks[i].text,
          vectorId: field === undefined
            ? DatabaseService.rowChunkVectorId(rowId, i)
            : `${rowId}__f_${field}__c${i}`,
        })
      }
    }

    if (strategy === 'row' || strategy === 'row+field') {
      await pushChunks(this.embeddingTextFromRecord(rec, columns))
    }
    if (strategy === 'field' || strategy === 'row+field') {
      for (const col of columns) {
        await pushChunks(this.embeddingTextFromRecord(rec, [col]), col.name)
      }
    }
    return tasks
  }

  /** 多行批量 upsert 向量：按数据集分块策略对行文本分块，每块一向量（RAG chunk 检索） */
  private async revectorizeRowsBatch(
    datasetId: string,
    meta: DatabaseDefinition,
    rows: Record<string, unknown>[]
  ): Promise<void> {
    if (!meta.indexCreated || rows.length === 0) return

    const columns = meta.columnDefinitions
    if (!columns.length) return

    const model = createEmbeddingModel(meta.embeddingModel)
    type RevectorizeTask = {
      rowId: string
      field?: string
      rec: Record<string, unknown>
      chunkIndex: number
      text: string
      vectorId: string
    }
    const tasks: RevectorizeTask[] = []
    const keepByRow = new Map<string, string[]>()

    for (const rec of rows) {
      const rowId = String(rec.id ?? '')
      if (!rowId) continue

      const fullText = this.embeddingTextFromRecord(rec, columns)
      if (!fullText.trim()) {
        await this.vectorService.deleteByRowId(datasetId, rowId)
        try {
          await this.vectorService.deleteByVectorId(datasetId, rowId)
        } catch {
          /* 旧版仅 vector_id=行 id、无 metadata.rowId */
        }
        continue
      }

      const built = await this.buildIndexTasks(datasetId, meta, rec)
      tasks.push(...built.map((t) => ({ ...t, rec })))
      keepByRow.set(rowId, built.map((t) => t.vectorId))
    }

    if (tasks.length === 0) return

    for (let offset = 0; offset < tasks.length; offset += EMBEDDING_UPSERT_BATCH_SIZE) {
      const slice = tasks.slice(offset, offset + EMBEDDING_UPSERT_BATCH_SIZE)
      const { embeddings } = await embedMany({ model, values: slice.map((t) => t.text) })
      if (embeddings.length !== slice.length) {
        throw new Error('Embedding count does not match chunk count during batch revectorize')
      }

      const vectorMetas = slice.map((t) => {
        const payload: Record<string, unknown> = {
          rowId: t.rowId,
          chunkIndex: t.chunkIndex,
          text: t.text
        }
        if (t.field !== undefined) payload.field = t.field
        for (const col of columns) {
          if (col.name in t.rec) payload[col.name] = t.rec[col.name]
        }
        return payload
      })
      const ids = slice.map((t) => t.vectorId)
      await this.vectorService.upsertVectors(datasetId, embeddings, vectorMetas as any, ids)
    }

    // 新向量全部写入后再清理陈旧向量：模型或写入失败时旧向量仍在，不会出现行无向量
    for (const [rowId, keep] of keepByRow) {
      await this.vectorService.pruneByRowId(datasetId, rowId, keep)
      try {
        await this.vectorService.deleteByVectorId(datasetId, rowId)
      } catch {
        /* 旧版单行向量 */
      }
    }
  }

  /**
   * 列定义删除旧字段后，按当前列定义对动态表全量重算 embedding 并 upsert（与批量写入的向量 metadata 形状一致）
   */
  private async revectorizeAllRowsInDataset(datasetId: string): Promise<void> {
    const meta = await this.getDatabase(datasetId)
    if (!meta?.indexCreated) return

    const columns = meta.columnDefinitions
    if (!columns.length) return

    assertSafeIdentifier(meta.dataTableName)
    const client = await pool.connect()
    let rows: Record<string, unknown>[]
    try {
      await client.query(`SET search_path TO ${schemaName}, public`)
      const res = await client.query(`SELECT * FROM ${schemaName}.${meta.dataTableName} ORDER BY id`)
      rows = res.rows as Record<string, unknown>[]
    } finally {
      client.release()
    }

    if (rows.length === 0) return
    await this.revectorizeRowsBatch(datasetId, meta, rows)
  }

  private allowedRowKeys(columns: DatabaseColumnDefinition[]): Set<string> {
    return new Set<string>(['id', ...columns.map((c) => c.name)])
  }

  async insertRow(
    datasetId: string,
    payload: Record<string, unknown>,
    rowId?: string
  ): Promise<Record<string, unknown>> {
    const meta = await this.getDatabase(datasetId)
    if (!meta) throw new Error(`Dataset ${datasetId} not found`)

    const columns = meta.columnDefinitions
    const allowed = this.allowedRowKeys(columns)
    const id =
      (typeof payload.id === 'string' ? payload.id : rowId) ||
      `r_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`

    for (const key of Object.keys(payload)) {
      if (!allowed.has(key)) {
        throw new Error(`Unknown column: ${key}`)
      }
    }

    const now = new Date()
    const entries: [string, unknown][] = [['id', id]]
    for (const col of columns) {
      if (col.name in payload) {
        entries.push([col.name, payload[col.name]])
      } else if (col.notNull) {
        throw new Error(`Missing required column: ${col.name}`)
      }
    }

    const colNames = entries.map(([k]) => k)
    for (const n of colNames) assertSafeIdentifier(n)

    const values = entries.map(([, v]) => v)
    const placeholders = values.map((_, i) => `$${i + 1}`)

    const client = await pool.connect()
    try {
      await client.query(`SET search_path TO ${schemaName}, public`)
      const q = `
        INSERT INTO ${schemaName}.${meta.dataTableName} (${colNames.map((n) => `"${n}"`).join(', ')}, updated_at)
        VALUES (${placeholders.join(', ')}, $${values.length + 1})
      `
      await client.query(q, [...values, now])
    } finally {
      client.release()
    }

    return (await this.getRow(datasetId, id))!
  }

  /**
   * 批量写入：每条记录一行；向量化时对「列顺序拼接全文」按数据集分块策略切块，每块一向量（RAG）
   * 大量数据时：动态表多行 INSERT、并行分块、分批 embedding + upsert，降低总耗时与内存峰值
   */
  async insertRowsFromMetadataBatch(
    datasetId: string,
    records: Record<string, unknown>[]
  ): Promise<{ count: number; rows: Record<string, unknown>[] }> {
    const meta = await this.getDatabase(datasetId)
    if (!meta) throw new Error(`Dataset ${datasetId} not found`)

    const columns = meta.columnDefinitions
    if (!columns.length) {
      throw new Error('Dataset has no column definitions')
    }

    if (!meta.indexCreated) {
      throw new Error('Vector index is not ready for this dataset')
    }

    if (meta.keyColumn) {
      return this.upsertRowsByKey(datasetId, meta, records)
    }

    const texts = records.map((rec) => this.embeddingTextFromRecord(rec, columns))
    const emptyIdx = texts.findIndex((t) => !t || !String(t).trim())
    if (emptyIdx !== -1) {
      throw new Error(`Empty embedding text at rows[${emptyIdx}] (check column values)`)
    }
    const baseTs = Date.now()
    const rowIds = records.map(
      (_, i) => `r_${baseTs}_${i}_${Math.random().toString(36).substring(2, 11)}`
    )

    const dynColList = columns.map((c) => `"${c.name}"`).join(', ')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SET search_path TO ${schemaName}, public`)

      for (let start = 0; start < records.length; start += PHYSICAL_INSERT_BATCH_SIZE) {
        const end = Math.min(start + PHYSICAL_INSERT_BATCH_SIZE, records.length)
        const valueGroups: string[] = []
        const flatVals: unknown[] = []
        let param = 1
        for (let i = start; i < end; i++) {
          const rec = records[i]
          const rowId = rowIds[i]
          const vals: unknown[] = [rowId]
          for (const col of columns) {
            if (col.name in rec) {
              vals.push(rec[col.name])
            } else if (col.notNull) {
              throw new Error(`Missing required column in rows[${i}]: ${col.name}`)
            } else {
              vals.push(null)
            }
          }
          const rowPh = vals.map(() => `$${param++}`).join(', ')
          valueGroups.push(`(${rowPh}, NOW())`)
          flatVals.push(...vals)
        }
        await client.query(
          `INSERT INTO ${schemaName}.${meta.dataTableName} (id, ${dynColList}, updated_at) VALUES ${valueGroups.join(', ')}`,
          flatVals
        )
      }

      await client.query('COMMIT')
    } catch (e: any) {
      try {
        await client.query('ROLLBACK')
      } catch {
        /* ignore */
      }
      throw new Error(`Failed to insert rows: ${e.message}`)
    } finally {
      client.release()
    }

    try {
      const chunkTasks: Array<{ rowId: string; field?: string; rec: Record<string, unknown>; chunkIndex: number; text: string; vectorId: string }> = []
      const recById = new Map<string, Record<string, unknown>>()
      for (let i = 0; i < records.length; i++) recById.set(rowIds[i], { ...records[i], id: rowIds[i] })
      for (let b = 0; b < records.length; b += CHUNK_TEXT_BUILD_CONCURRENCY) {
        const end = Math.min(b + CHUNK_TEXT_BUILD_CONCURRENCY, records.length)
        const wave = await Promise.all(
          Array.from({ length: end - b }, async (_, k) => {
            const i = b + k
            const tasks = await this.buildIndexTasks(datasetId, meta, recById.get(rowIds[i])!)
            return { i, tasks }
          })
        )
        wave.sort((a, c) => a.i - c.i)
        for (const { tasks } of wave) {
          chunkTasks.push(...tasks.map((t) => ({ ...t, rec: recById.get(t.rowId)! })))
        }
      }

      const model = createEmbeddingModel(meta.embeddingModel)
      for (let off = 0; off < chunkTasks.length; off += EMBEDDING_UPSERT_BATCH_SIZE) {
        const slice = chunkTasks.slice(off, off + EMBEDDING_UPSERT_BATCH_SIZE)
        const { embeddings } = await embedMany({
          model,
          values: slice.map((t) => t.text)
        })
        if (embeddings.length !== slice.length) {
          throw new Error('Embedding count does not match chunk count')
        }

        const vectorMetas = slice.map((t) => {
          const payload: Record<string, unknown> = {
            rowId: t.rowId,
            chunkIndex: t.chunkIndex,
            text: t.text
          }
          if (t.field !== undefined) payload.field = t.field
          for (const col of columns) {
            if (col.name in t.rec) payload[col.name] = t.rec[col.name]
          }
          return payload
        })
        const vectorIds = slice.map((t) => t.vectorId)
        await this.vectorService.upsertVectors(datasetId, embeddings, vectorMetas as any, vectorIds)
      }

      const rows = await this.getRowsByIdsOrdered(meta, rowIds)
      return { count: rows.length, rows }
    } catch (e: any) {
      // 行已提交、向量未完整写入：删除本次写入的行与已写入的向量，保证调用方要么全部成功，要么无残留
      await this.compensateInsertedRows(datasetId, meta, rowIds)
      throw new Error(`Failed to index rows: ${e?.message ?? e}`)
    }
  }

  /**
   * 幂等写入（数据集配置了 keyColumn）：按业务 key upsert，相同 key 覆盖整行，重试同一批次不产生重复行。
   * 语义与补偿：行先提交再写向量；向量失败时只删除本次新插入的行与向量，被覆盖的行保留（旧向量在
   * 新向量全部写入后才清理，失败时仍在，重试即可收敛）。批内重复 key 与缺失 key 直接拒绝。
   */
  private async upsertRowsByKey(
    datasetId: string,
    meta: DatabaseDefinition,
    records: Record<string, unknown>[]
  ): Promise<{ count: number; rows: Record<string, unknown>[] }> {
    const columns = meta.columnDefinitions
    const keyColumn = meta.keyColumn!
    assertSafeIdentifier(keyColumn)

    const keys = records.map((rec, i) => {
      const v = rec[keyColumn]
      if (v === null || v === undefined || String(v).trim() === '') {
        throw new Error(`Missing key column "${keyColumn}" in rows[${i}]`)
      }
      return String(v)
    })
    const firstIndexByKey = new Map<string, number>()
    keys.forEach((k, i) => {
      const first = firstIndexByKey.get(k)
      if (first !== undefined) {
        throw new Error(`Duplicate key "${k}" in rows[${first}] and rows[${i}]`)
      }
      firstIndexByKey.set(k, i)
    })

    const texts = records.map((rec) => this.embeddingTextFromRecord(rec, columns))
    const emptyIdx = texts.findIndex((t) => !t.trim())
    if (emptyIdx !== -1) {
      throw new Error(`Empty embedding text at rows[${emptyIdx}] (check column values)`)
    }

    const dynColList = columns.map((c) => `"${c.name}"`).join(', ')
    const updateSet = [
      ...columns.filter((c) => c.name !== keyColumn).map((c) => `"${c.name}" = EXCLUDED."${c.name}"`),
      'updated_at = NOW()'
    ].join(', ')

    const baseTs = Date.now()
    const idByKey = new Map<string, { id: string; inserted: boolean }>()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SET search_path TO ${schemaName}, public`)

      for (let start = 0; start < records.length; start += PHYSICAL_INSERT_BATCH_SIZE) {
        const end = Math.min(start + PHYSICAL_INSERT_BATCH_SIZE, records.length)
        const valueGroups: string[] = []
        const flatVals: unknown[] = []
        let param = 1
        for (let i = start; i < end; i++) {
          const rec = records[i]
          const vals: unknown[] = [`r_${baseTs}_${i}_${Math.random().toString(36).substring(2, 11)}`]
          for (const col of columns) {
            if (col.name in rec) {
              vals.push(rec[col.name])
            } else if (col.notNull) {
              throw new Error(`Missing required column in rows[${i}]: ${col.name}`)
            } else {
              vals.push(null)
            }
          }
          valueGroups.push(`(${vals.map(() => `$${param++}`).join(', ')}, NOW())`)
          flatVals.push(...vals)
        }
        // xmax = 0 表示本行是新插入；冲突更新的行 xmax 非 0
        const res = await client.query(
          `INSERT INTO ${schemaName}.${meta.dataTableName} (id, ${dynColList}, updated_at)
           VALUES ${valueGroups.join(', ')}
           ON CONFLICT ("${keyColumn}") DO UPDATE SET ${updateSet}
           RETURNING id, "${keyColumn}" AS k, (xmax = 0) AS inserted`,
          flatVals
        )
        for (const r of res.rows as Array<{ id: string; k: string; inserted: boolean }>) {
          idByKey.set(String(r.k), { id: String(r.id), inserted: Boolean(r.inserted) })
        }
      }

      await client.query('COMMIT')
    } catch (e: any) {
      try {
        await client.query('ROLLBACK')
      } catch {
        /* ignore */
      }
      throw new Error(`Failed to insert rows: ${e.message}`)
    } finally {
      client.release()
    }

    const rowIds = keys.map((k) => idByKey.get(k)!.id)
    const insertedIds = keys.filter((k) => idByKey.get(k)!.inserted).map((k) => idByKey.get(k)!.id)
    const updatedIds = keys.filter((k) => !idByKey.get(k)!.inserted).map((k) => idByKey.get(k)!.id)

    try {
      const recById = new Map<string, Record<string, unknown>>()
      keys.forEach((_, i) => recById.set(rowIds[i], { ...records[i], id: rowIds[i] }))

      const chunkTasks: Array<{ rowId: string; field?: string; rec: Record<string, unknown>; chunkIndex: number; text: string; vectorId: string }> = []
      for (let b = 0; b < records.length; b += CHUNK_TEXT_BUILD_CONCURRENCY) {
        const end = Math.min(b + CHUNK_TEXT_BUILD_CONCURRENCY, records.length)
        const wave = await Promise.all(
          Array.from({ length: end - b }, async (_, k) => {
            const i = b + k
            const tasks = await this.buildIndexTasks(datasetId, meta, recById.get(rowIds[i])!)
            return { i, tasks }
          })
        )
        wave.sort((a, c) => a.i - c.i)
        for (const { tasks } of wave) {
          chunkTasks.push(...tasks.map((t) => ({ ...t, rec: recById.get(t.rowId)! })))
        }
      }

      const keepByRow = new Map<string, string[]>()
      for (const t of chunkTasks) {
        const list = keepByRow.get(t.rowId) ?? []
        list.push(t.vectorId)
        keepByRow.set(t.rowId, list)
      }

      const model = createEmbeddingModel(meta.embeddingModel)
      for (let off = 0; off < chunkTasks.length; off += EMBEDDING_UPSERT_BATCH_SIZE) {
        const slice = chunkTasks.slice(off, off + EMBEDDING_UPSERT_BATCH_SIZE)
        const { embeddings } = await embedMany({ model, values: slice.map((t) => t.text) })
        if (embeddings.length !== slice.length) {
          throw new Error('Embedding count does not match chunk count')
        }
        const vectorMetas = slice.map((t) => {
          const payload: Record<string, unknown> = { rowId: t.rowId, chunkIndex: t.chunkIndex, text: t.text }
          if (t.field !== undefined) payload.field = t.field
          for (const col of columns) {
            if (col.name in t.rec) payload[col.name] = t.rec[col.name]
          }
          return payload
        })
        await this.vectorService.upsertVectors(datasetId, embeddings, vectorMetas as any, slice.map((t) => t.vectorId))
      }

      // 新向量全部写入后，清理被覆盖行的陈旧向量
      for (const rowId of new Set(updatedIds)) {
        await this.vectorService.pruneByRowId(datasetId, rowId, keepByRow.get(rowId) ?? [])
      }

      const rows = await this.getRowsByIdsOrdered(meta, rowIds)
      return { count: rows.length, rows }
    } catch (e: any) {
      await this.compensateInsertedRows(datasetId, meta, insertedIds)
      throw new Error(`Failed to index rows: ${e?.message ?? e}`)
    }
  }

  /** 补偿删除本次写入失败的行与向量；清理失败只记录日志，原始错误仍由调用方抛出 */
  private async compensateInsertedRows(
    datasetId: string,
    meta: Pick<DatabaseDefinition, 'dataTableName'>,
    rowIds: string[]
  ): Promise<void> {
    if (rowIds.length === 0) return
    const failures: string[] = []
    for (const rowId of rowIds) {
      try {
        await this.vectorService.deleteByRowId(datasetId, rowId)
      } catch (e: any) {
        failures.push(`vector:${rowId}:${e?.message ?? e}`)
      }
    }
    const client = await pool.connect()
    try {
      await client.query(`SET search_path TO ${schemaName}, public`)
      await client.query(`DELETE FROM ${schemaName}.${meta.dataTableName} WHERE id = ANY($1::text[])`, [rowIds])
    } catch (e: any) {
      failures.push(`rows:${e?.message ?? e}`)
    } finally {
      client.release()
    }
    if (failures.length) {
      console.error('[database] insert compensation incomplete, manual reconcile required:', failures.slice(0, 5))
    }
  }

  /**
   * 索引名称冲突检查（建库前）：物理向量表、注册表索引名或数据表名已被占用时拒绝，避免数据串库。
   * 冲突时抛出 code=INDEX_NAME_CONFLICT，路由映射为 409。
   */
  private async assertIndexNameAvailable(id: string, indexName: string, dataTableName: string): Promise<void> {
    const client = await pool.connect()
    try {
      await client.query(`SET search_path TO ${schemaName}, public`)
      const registry = await client.query(
        `SELECT id FROM ${schemaName}.databases WHERE index_name = $1 OR data_table_name = $2 LIMIT 1`,
        [indexName, dataTableName]
      )
      const kb = await client
        .query(`SELECT id FROM ${schemaName}.knowledge_bases WHERE index_name = $1 LIMIT 1`, [indexName])
        .catch(() => ({ rows: [] as unknown[] }))
      const physical = await client.query(`SELECT to_regclass($1) AS reg`, [`${schemaName}.${indexName}`])
      if (registry.rows.length || kb.rows.length || physical.rows[0]?.reg) {
        throw Object.assign(
          new Error(`Dataset "${id}" conflicts with existing index "${indexName}"`),
          { code: 'INDEX_NAME_CONFLICT' }
        )
      }
    } finally {
      client.release()
    }
  }

  async getDatabase(id: string, options?: { includeStats?: boolean }): Promise<DatabaseDefinition | null> {
    const [row] = await db.select().from(databaseBases).where(eq(databaseBases.id, id)).limit(1)
    if (!row) return null

    const base = this.mapRow(row)
    if (options?.includeStats) {
      base.rowCount = await this.countRows(id)
    }
    return base
  }

  async listDatabases(options?: {
    page?: number
    pageSize?: number
    search?: string
    orderBy?: 'createdAt' | 'updatedAt' | 'name'
    orderDirection?: 'ASC' | 'DESC'
    includeStats?: boolean
  }): Promise<{
    items: DatabaseDefinition[]
    total: number
    page: number
    pageSize: number
    totalPages: number
  }> {
    const page = options?.page && options.page > 0 ? options.page : 1
    const pageSize =
      options?.pageSize && options.pageSize > 0 && options.pageSize <= 100 ? options.pageSize : 20
    const offset = (page - 1) * pageSize
    const search = options?.search?.trim()
    const orderBy = options?.orderBy || 'createdAt'
    const orderDirection = options?.orderDirection || 'DESC'

    let query = db.select().from(databaseBases)
    if (search) {
      const searchTerm = `%${search}%`
      query = query.where(
        or(ilike(databaseBases.name, searchTerm), ilike(databaseBases.description, searchTerm))!
      ) as any
    }

    const orderCol =
      orderBy === 'name'
        ? databaseBases.name
        : orderBy === 'updatedAt'
          ? databaseBases.updatedAt
          : databaseBases.createdAt
    const orderFn = orderDirection === 'ASC' ? asc : desc

    const countQuery = db.select({ count: sql<number>`count(*)::int` }).from(databaseBases)
    if (search) {
      const searchTerm = `%${search}%`
      countQuery.where(
        or(ilike(databaseBases.name, searchTerm), ilike(databaseBases.description, searchTerm))! as any
      )
    }

    const countResult = await countQuery.execute()
    const total = countResult[0]?.count || 0

    const rows = await query.orderBy(orderFn(orderCol)).limit(pageSize).offset(offset)

    const items: DatabaseDefinition[] = []
    for (const r of rows) {
      const item = this.mapRow(r)
      if (options?.includeStats) {
        item.rowCount = await this.countRows(r.id)
      }
      items.push(item)
    }

    return {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize)
    }
  }

  async deleteDatabase(id: string): Promise<void> {
    const meta = await this.getDatabase(id)
    if (!meta) {
      throw new Error(`Dataset ${id} not found`)
    }
    await this.vectorService.deleteIndex(id)
    await this.dropPhysicalTable(meta.dataTableName)
    await db.delete(databaseBases).where(eq(databaseBases.id, id))
  }

  async getRow(datasetId: string, rowId: string): Promise<Record<string, unknown> | null> {
    const meta = await this.getDatabase(datasetId)
    if (!meta) throw new Error(`Dataset ${datasetId} not found`)

    assertSafeIdentifier(meta.dataTableName)
    const client = await pool.connect()
    try {
      await client.query(`SET search_path TO ${schemaName}, public`)
      const res = await client.query(`SELECT * FROM ${schemaName}.${meta.dataTableName} WHERE id = $1 LIMIT 1`, [
        rowId
      ])
      if (res.rows.length === 0) return null
      return res.rows[0] as Record<string, unknown>
    } finally {
      client.release()
    }
  }

  /** 按 rowIds 顺序返回行（一次查询，避免 N 次 getRow） */
  private async getRowsByIdsOrdered(meta: DatabaseDefinition, rowIds: string[]): Promise<Record<string, unknown>[]> {
    if (rowIds.length === 0) return []
    assertSafeIdentifier(meta.dataTableName)
    const client = await pool.connect()
    try {
      await client.query(`SET search_path TO ${schemaName}, public`)
      const res = await client.query(
        `SELECT * FROM ${schemaName}.${meta.dataTableName} WHERE id = ANY($1::varchar[])`,
        [rowIds]
      )
      const byId = new Map<string, Record<string, unknown>>()
      for (const row of res.rows as Record<string, unknown>[]) {
        byId.set(String(row.id), row)
      }
      return rowIds.map((id) => byId.get(id)).filter((r): r is Record<string, unknown> => r != null)
    } finally {
      client.release()
    }
  }

  async listRows(
    datasetId: string,
    options?: { page?: number; pageSize?: number; filter?: Record<string, unknown> }
  ): Promise<{ items: Record<string, unknown>[]; total: number; page: number; pageSize: number; totalPages: number }> {
    const meta = await this.getDatabase(datasetId)
    if (!meta) throw new Error(`Dataset ${datasetId} not found`)

    const page = options?.page && options.page > 0 ? options.page : 1
    const pageSize =
      options?.pageSize && options.pageSize > 0 && options.pageSize <= 200 ? options.pageSize : 20
    const offset = (page - 1) * pageSize

    assertSafeIdentifier(meta.dataTableName)
    const hasFilter = options?.filter != null && Object.keys(options.filter).length > 0
    const filterWhere = hasFilter ? buildRowsFilterWhere(meta, options.filter as Record<string, unknown>) : null
    const whereSql = filterWhere ? ` WHERE ${filterWhere.whereClause}` : ''
    const client = await pool.connect()
    try {
      await client.query(`SET search_path TO ${schemaName}, public`)
      const countRes = await client.query(
        `SELECT COUNT(*)::int AS c FROM ${schemaName}.${meta.dataTableName}${whereSql}`,
        filterWhere?.params ?? []
      )
      const total = Number(countRes.rows[0]?.c ?? 0)
      const res = await client.query(
        `SELECT * FROM ${schemaName}.${meta.dataTableName}${whereSql} ORDER BY created_at DESC LIMIT $${
          (filterWhere?.params.length ?? 0) + 1
        } OFFSET $${(filterWhere?.params.length ?? 0) + 2}`,
        [...(filterWhere?.params ?? []), pageSize, offset]
      )
      return {
        items: res.rows as Record<string, unknown>[],
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize) || 1
      }
    } finally {
      client.release()
    }
  }

  /**
   * 在已设置 search_path 的 client 上执行单行 UPDATE；无字段变更时校验行存在并返回 noop
   */
  private async executeRowUpdate(
    meta: DatabaseDefinition,
    rowId: string,
    patch: Record<string, unknown>,
    client: PoolClient
  ): Promise<'noop' | 'updated'> {
    assertSafeIdentifier(meta.dataTableName)
    const allowed = new Set(meta.columnDefinitions.map((c) => c.name))
    const sets: string[] = []
    const values: unknown[] = []
    let i = 1

    for (const [key, val] of Object.entries(patch)) {
      if (key === 'id') continue
      if (!allowed.has(key)) {
        throw new Error(`Unknown column: ${key}`)
      }
      assertSafeIdentifier(key)
      sets.push(`"${key}" = $${i++}`)
      values.push(val)
    }

    if (sets.length === 0) {
      const res = await client.query(
        `SELECT 1 FROM ${schemaName}.${meta.dataTableName} WHERE id = $1 LIMIT 1`,
        [rowId]
      )
      if (res.rowCount === 0) throw new Error('Row not found')
      return 'noop'
    }

    sets.push(`updated_at = $${i++}`)
    values.push(new Date())
    values.push(rowId)

    const q = `
      UPDATE ${schemaName}.${meta.dataTableName}
      SET ${sets.join(', ')}
      WHERE id = $${i}
    `
    const res = await client.query(q, values)
    if (res.rowCount === 0) throw new Error('Row not found')
    return 'updated'
  }

  async updateRowsBatch(datasetId: string, request: BatchRowsUpdateRequest): Promise<{
    rows: Record<string, unknown>[]
  }> {
    const meta = await this.getDatabase(datasetId)
    if (!meta) throw new Error(`Dataset ${datasetId} not found`)

    const items = request.items
    const updatedIds = new Set<string>()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SET search_path TO ${schemaName}, public`)
      for (const { id, patch } of items) {
        const o = await this.executeRowUpdate(meta, id, patch, client)
        if (o === 'updated') updatedIds.add(id)
      }
      await client.query('COMMIT')
    } catch (e: any) {
      try {
        await client.query('ROLLBACK')
      } catch {
        /* ignore */
      }
      throw new Error(e.message || 'Failed to batch update rows')
    } finally {
      client.release()
    }

    const rows: Record<string, unknown>[] = []
    const toRevectorize: Record<string, unknown>[] = []
    for (const { id } of items) {
      const row = await this.getRow(datasetId, id)
      if (!row) throw new Error(`Row not found: ${id}`)
      rows.push(row)
      if (updatedIds.has(id)) toRevectorize.push(row)
    }

    await this.revectorizeRowsBatch(datasetId, meta, toRevectorize)
    return { rows }
  }

  async deleteRowsBatch(datasetId: string, request: BatchRowsDeleteRequest): Promise<{ deleted: number }> {
    const meta = await this.getDatabase(datasetId)
    if (!meta) throw new Error(`Dataset ${datasetId} not found`)

    const ids = [...new Set(request.ids)]
    assertSafeIdentifier(meta.dataTableName)

    for (const rowId of ids) {
      try {
        await this.vectorService.deleteByRowId(datasetId, rowId)
      } catch {
        /* ignore */
      }
      try {
        await this.vectorService.deleteByVectorId(datasetId, rowId)
      } catch {
        /* 旧版单行向量 id=行 id */
      }
    }

    const client = await pool.connect()
    try {
      await client.query(`SET search_path TO ${schemaName}, public`)
      const res = await client.query(
        `DELETE FROM ${schemaName}.${meta.dataTableName} WHERE id = ANY($1::text[]) RETURNING id`,
        [ids]
      )
      const deleted = new Set(res.rows.map((r: { id: string }) => r.id))
      for (const id of ids) {
        if (!deleted.has(id)) throw new Error(`Row not found: ${id}`)
      }
      return { deleted: ids.length }
    } finally {
      client.release()
    }
  }

  async upsertVectors(
    datasetId: string,
    vectors: number[][],
    metadata: Array<Record<string, unknown>>,
    ids?: string[]
  ): Promise<void> {
    const meta = await this.getDatabase(datasetId)
    if (!meta) throw new Error(`Dataset ${datasetId} not found`)
    if (!meta.indexCreated) {
      throw new Error('Vector index is not ready for this dataset')
    }
    await this.vectorService.upsertVectors(datasetId, vectors, metadata as any, ids)
  }

  async queryVectors(
    datasetId: string,
    queryVector: number[],
    topK: number,
    filter?: Record<string, unknown>,
    pgVectorConfig?: { minScore?: number; ef?: number; probes?: number }
  ) {
    const meta = await this.getDatabase(datasetId)
    if (!meta) throw new Error(`Dataset ${datasetId} not found`)
    return this.vectorService.query(datasetId, queryVector, topK, filter as any, pgVectorConfig)
  }

  /**
   * 自然语言 query → embedding → kb_* 向量检索；可选回填动态表完整行
   */
  async searchRowsSemantic(
    datasetId: string,
    query: string,
    options?: {
      topK?: number
      minScore?: number
      ef?: number
      probes?: number
    }
  ): Promise<
    Array<{
      score: number
      vectorId: string
      metadata: Record<string, unknown>
      row?: Record<string, unknown>
    }>
  > {
    const meta = await this.getDatabase(datasetId)
    if (!meta) throw new Error(`Dataset ${datasetId} not found`)
    if (!meta.indexCreated) {
      throw new Error('Vector index is not ready for this dataset')
    }

    const topK = options?.topK ?? 6
    const embedding = await generateQueryEmbedding(query, meta.embeddingModel)
    const pgVectorConfig: { minScore?: number; ef?: number; probes?: number } = {}
    if (options?.minScore !== undefined) pgVectorConfig.minScore = options.minScore
    if (options?.ef !== undefined) pgVectorConfig.ef = options.ef
    if (options?.probes !== undefined) pgVectorConfig.probes = options.probes

    const raw = (await this.vectorService.query(
      datasetId,
      embedding,
      topK,
      undefined,
      Object.keys(pgVectorConfig).length ? pgVectorConfig : undefined
    )) as Array<{ id?: string; score?: number; metadata?: Record<string, unknown> }>

    const out: Array<{
      score: number
      vectorId: string
      metadata: Record<string, unknown>
      row?: Record<string, unknown>
    }> = []

    for (const r of raw) {
      const vectorId = String(r.id ?? '')
      const md = (r.metadata || {}) as Record<string, unknown>
      const item: {
        score: number
        vectorId: string
        metadata: Record<string, unknown>
      } = {
        score: Number(r.score ?? 0),
        vectorId,
        metadata: md
      }
      out.push(item)
    }
    return out
  }

  /**
   * 先按列条件 SQL 过滤，再在命中的行集合上做自然语言向量检索（chunk 级命中，metadata.rowId 对应行）
   */
  async searchRowsSqlThenSemantic(
    datasetId: string,
    filter: Record<string, unknown>,
    textQuery: string,
    options?: {
      topK?: number
      limit?: number
      minScore?: number
      ef?: number
      probes?: number
    }
  ): Promise<
    Array<{
      score: number
      vectorId: string
      metadata: Record<string, unknown>
      row: Record<string, unknown>
    }>
  > {
    const limit = options?.limit ?? 100
    const filteredRows = await this.searchRowsByFilter(datasetId, filter, limit)
    const allowedIds = new Set(
      filteredRows.map((r) => String(r.id ?? '')).filter((id) => id.length > 0)
    )
    if (allowedIds.size === 0) {
      return []
    }

    const rowMap = new Map<string, Record<string, unknown>>()
    for (const r of filteredRows) {
      const id = String(r.id ?? '')
      if (id) rowMap.set(id, r)
    }

    const meta = await this.getDatabase(datasetId)
    if (!meta) throw new Error(`Dataset ${datasetId} not found`)
    if (!meta.indexCreated) {
      throw new Error('Vector index is not ready for this dataset')
    }

    const topK = options?.topK ?? 6
    const fetchK = Math.min(500, Math.max(topK * 30, 50))

    const embedding = await generateQueryEmbedding(textQuery, meta.embeddingModel)
    const pgVectorConfig: { minScore?: number; ef?: number; probes?: number } = {}
    if (options?.minScore !== undefined) pgVectorConfig.minScore = options.minScore
    if (options?.ef !== undefined) pgVectorConfig.ef = options.ef
    if (options?.probes !== undefined) pgVectorConfig.probes = options.probes

    const raw = (await this.vectorService.query(
      datasetId,
      embedding,
      fetchK,
      undefined,
      Object.keys(pgVectorConfig).length ? pgVectorConfig : undefined
    )) as Array<{ id?: string; score?: number; metadata?: Record<string, unknown> }>

    const inSubset = raw
      .filter((r) => {
        const md = (r.metadata || {}) as Record<string, unknown>
        const rowId = this.resolveRowIdFromVectorId(String(r.id ?? ''), md)
        return rowId.length > 0 && allowedIds.has(rowId)
      })
      .sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0))
      .slice(0, topK)

    return inSubset.map((r) => {
      const vectorId = String(r.id ?? '')
      const md = (r.metadata || {}) as Record<string, unknown>
      const rowId = this.resolveRowIdFromVectorId(vectorId, md)
      const row = rowMap.get(rowId)
      if (!row) {
        throw new Error(`Inconsistent vector row id: ${rowId}`)
      }
      return {
        score: Number(r.score ?? 0),
        vectorId,
        metadata: md,
        row
      }
    })
  }

  /**
   * 按属性键值查询（服务端拼接 WHERE，不接收原始 SQL）
   * - 动态列当前均为 TEXT：字符串条件使用 trim + 不区分大小写子串匹配（ILIKE %...%），避免精确 = 搜不到（空格、子串）
   * - 数字 / 布尔：转为文本后与 trim(col::text) 比较
   * - id 列：仍用精确匹配
   * - null：IS NULL
   */
  async searchRowsByFilter(
    datasetId: string,
    filter: Record<string, unknown>,
    limit: number,
    options?: { idOnly?: boolean }
  ): Promise<Record<string, unknown>[]> {
    const meta = await this.getDatabase(datasetId)
    if (!meta) throw new Error(`Dataset ${datasetId} not found`)

    assertSafeIdentifier(meta.dataTableName)
    const { whereClause, params } = buildRowsFilterWhere(meta, filter)
    const lim = Math.min(Math.max(1, limit), ROWS_SEARCH_MAX_FILTER_LIMIT)
    const selectClause = options?.idOnly ? 'id' : '*'
    const client = await pool.connect()
    try {
      await client.query(`SET search_path TO ${schemaName}, public`)
      const q = `SELECT ${selectClause} FROM ${schemaName}.${meta.dataTableName} WHERE ${whereClause} ORDER BY updated_at DESC LIMIT ${lim}`
      const res = await client.query(q, params)
      return res.rows as Record<string, unknown>[]
    } finally {
      client.release()
    }
  }

  /**
   * 为检索结果回填动态表行（chunk 向量 id 与行 id 不同，优先 metadata.rowId）
   */
  async hydrateSearchResults(
    datasetId: string,
    results: SearchResultItem[]
  ): Promise<Array<SearchResultItem & { row?: Record<string, unknown> }>> {
    if (results.length === 0) return []

    const meta = await this.getDatabase(datasetId)
    if (!meta) throw new Error(`Dataset ${datasetId} not found`)

    const rowIdsByResult = results.map((r) => this.resolveRowIdFromVectorId(r.id, r.metadata))
    const uniqueRowIds = Array.from(new Set(rowIdsByResult.filter((id) => id.length > 0)))
    const rows = await this.getRowsByIdsOrdered(meta, uniqueRowIds)
    const rowMap = new Map<string, Record<string, unknown>>()
    for (const row of rows) {
      const id = String(row.id ?? '')
      if (id) rowMap.set(id, row)
    }

    return results.map((r, idx) => {
      const rowId = rowIdsByResult[idx] || ''
      return {
        ...r,
        documentId: rowId,
        row: rowMap.get(rowId)
      }
    })
  }

  private async countRows(datasetId: string): Promise<number> {
    const meta = await this.getDatabase(datasetId)
    if (!meta) return 0
    const client = await pool.connect()
    try {
      await client.query(`SET search_path TO ${schemaName}, public`)
      const res = await client.query(`SELECT COUNT(*)::int AS c FROM ${schemaName}.${meta.dataTableName}`)
      return Number(res.rows[0]?.c ?? 0)
    } finally {
      client.release()
    }
  }
}
