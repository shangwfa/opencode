import { VectorService } from './vector.service'
import { KeywordSearchService } from './keyword-search.service'
import type { KnowledgeBase, Document, CreateKnowledgeBaseRequest, ChunkStrategy } from '../types/knowledge-base.types'
import { db, knowledgeBases, documents, schemaName, pool } from '../../../db/index.js'
import { eq, desc, or, ilike, sql, asc } from 'drizzle-orm'
import { getKnowledgeBaseIndexName } from '../../../utils/index-name.js'
import { getDatabaseSchema } from '../../../config/env.js'

/**
 * 获取向量维度
 * 当前统一使用 openai/text-embedding-3-small (1536 维)
 */
function getEmbeddingDimension(): number {
  return 1536 // openai/text-embedding-3-small 固定维度
}

export class KnowledgeBaseService {
  private vectorService: VectorService
  private keywordSearchService?: KeywordSearchService

  constructor(vectorService: VectorService, keywordSearchService?: KeywordSearchService) {
    this.vectorService = vectorService
    this.keywordSearchService = keywordSearchService
  }

  /**
   * 创建知识库
   */
  async createKnowledgeBase(request: CreateKnowledgeBaseRequest): Promise<KnowledgeBase> {
    // 如果提供了ID，使用提供的ID；否则自动生成
    const id = request.id || `kb_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`
    const now = new Date()

    try {
      // 默认分块配置
      const defaultChunkConfig = {
        maxSize: 512,
        overlap: 50
      }

      const [result] = await db
        .insert(knowledgeBases)
        .values({
          id,
          name: request.name,
          description: request.description || null,
          embeddingModel: request.embeddingModel || 'openai/text-embedding-3-small',
          defaultChunkStrategy: request.defaultChunkStrategy || 'recursive',
          defaultChunkConfig: request.defaultChunkConfig || defaultChunkConfig,
          createdAt: now,
          updatedAt: now
        })
        .returning()

      if (!result) {
        throw new Error('Failed to create knowledge base: no rows inserted')
      }

      // 创建向量索引
      const indexName = getKnowledgeBaseIndexName(id)
      const indexDimension = getEmbeddingDimension() // 统一使用 1536 维
      const indexCreatedAt = new Date()

      try {
        await this.vectorService.createIndex(id, indexDimension)

        // 更新知识库记录，添加索引信息
        await db
          .update(knowledgeBases)
          .set({
            indexName,
            indexDimension,
            indexCreated: 1,
            indexCreatedAt,
            updatedAt: indexCreatedAt
          })
          .where(eq(knowledgeBases.id, id))

        // 自动创建多语言全文检索索引（在向量索引创建成功后）
        if (this.keywordSearchService) {
          try {
            await this.keywordSearchService.createPerformanceIndexes(id)
            console.log(`Auto-created multilingual full-text search indexes for knowledge base: ${id}`)
          } catch (fullTextIndexError: any) {
            // 全文检索索引创建失败不影响知识库创建，只记录警告
            console.warn(`Failed to create full-text search indexes for ${id}:`, fullTextIndexError.message)
          }
        }
      } catch (indexError: any) {
        console.error('Failed to create index:', indexError.message)
        // 即使索引创建失败，也记录失败状态
        await db
          .update(knowledgeBases)
          .set({
            indexName,
            indexDimension,
            indexCreated: 0,
            updatedAt: new Date()
          })
          .where(eq(knowledgeBases.id, id))
        throw indexError
      }

      // 获取更新后的记录
      const updatedResult = await this.getKnowledgeBase(id)
      if (!updatedResult) {
        throw new Error('Failed to retrieve created knowledge base')
      }

      return updatedResult
    } catch (error: any) {
      console.error('Error creating knowledge base:', error.message)
      throw new Error(`Failed to create knowledge base: ${error.message}`)
    }
  }

  /**
   * 获取知识库列表（支持分页、搜索、排序、统计）
   */
  async listKnowledgeBases(options?: {
    page?: number
    pageSize?: number
    search?: string
    orderBy?: 'createdAt' | 'updatedAt' | 'name'
    orderDirection?: 'ASC' | 'DESC'
    includeStats?: boolean
  }): Promise<{
    items: KnowledgeBase[]
    total: number
    page: number
    pageSize: number
    totalPages: number
  }> {
    const {
      page = 1,
      pageSize = 20,
      search,
      orderBy = 'createdAt',
      orderDirection = 'DESC',
      includeStats = false
    } = options || {}

    // 构建基础查询
    let query: any = db.select().from(knowledgeBases)

    // 搜索过滤（按名称或描述）
    if (search && search.trim()) {
      const searchTerm = `%${search.trim()}%`
      query = query.where(
        or(
          ilike(knowledgeBases.name, searchTerm),
          ilike(knowledgeBases.description, searchTerm)
        ) as any
      )
    }

    // 获取总数（应用相同的过滤条件）
    const countQuery = db
      .select({ count: sql<number>`count(*)::int` })
      .from(knowledgeBases)

    if (search && search.trim()) {
      const searchTerm = `%${search.trim()}%`
      countQuery.where(
        or(
          ilike(knowledgeBases.name, searchTerm),
          ilike(knowledgeBases.description, searchTerm)
        ) as any
      )
    }

    const countResult = await countQuery.execute()
    const total = countResult[0]?.count || 0

    // 构建排序
    const orderField =
      orderBy === 'name' ? knowledgeBases.name : orderBy === 'updatedAt' ? knowledgeBases.updatedAt : knowledgeBases.createdAt

    const orderClause = orderDirection === 'ASC' ? asc(orderField) : desc(orderField)

    // 执行分页查询
    const results = await query.orderBy(orderClause).limit(pageSize).offset((page - 1) * pageSize)

    // 数据映射
    let items = results.map((row: any) => ({
      id: row.id,
      name: row.name,
      description: row.description || undefined,
      embeddingModel: row.embeddingModel,
      defaultChunkStrategy: row.defaultChunkStrategy as ChunkStrategy,
      defaultChunkConfig: row.defaultChunkConfig as any,
      indexName: row.indexName || undefined,
      indexDimension: row.indexDimension || undefined,
      indexCreated: row.indexCreated === 1,
      indexCreatedAt: row.indexCreatedAt || undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    }))

    // 如果需要统计信息
    if (includeStats) {
      items = await Promise.all(
        items.map(async (kb: any) => {
          const stats = await this.getKnowledgeBaseStats(kb.id)
          return { ...kb, ...stats }
        })
      )
    }

    return {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize)
    }
  }

  /**
   * 获取知识库详情（包含统计信息）
   */
  async getKnowledgeBase(id: string): Promise<KnowledgeBase | null> {
    const [result] = await db.select().from(knowledgeBases).where(eq(knowledgeBases.id, id)).limit(1)

    if (!result) {
      return null
    }

    // 获取统计信息
    const stats = await this.getKnowledgeBaseStats(id)

    return {
      id: result.id,
      name: result.name,
      description: result.description || undefined,
      embeddingModel: result.embeddingModel,
      defaultChunkStrategy: result.defaultChunkStrategy as ChunkStrategy,
      defaultChunkConfig: result.defaultChunkConfig as any,
      indexName: result.indexName || undefined,
      indexDimension: result.indexDimension || undefined,
      indexCreated: result.indexCreated === 1,
      indexCreatedAt: result.indexCreatedAt || undefined,
      createdAt: result.createdAt,
      updatedAt: result.updatedAt,
      // 统计信息
      documentCount: stats.documentCount,
      chunkCount: stats.chunkCount
    }
  }

  /**
   * 删除知识库
   */
  async deleteKnowledgeBase(id: string): Promise<void> {
    // 删除向量索引
    await this.vectorService.deleteIndex(id)

    // 删除知识库（级联删除文档）
    await db.delete(knowledgeBases).where(eq(knowledgeBases.id, id))
  }

  /**
   * 创建文档
   */
  async createDocument(
    knowledgeBaseId: string,
    content: string,
    type: 'text' | 'markdown' | 'html' | 'tiptap' = 'text',
    chunkStrategy?: ChunkStrategy,
    chunkConfig?: any,
    metadata?: Record<string, any>,
    id?: string
  ): Promise<Document> {
    // 如果用户提供了ID，使用用户提供的ID；否则自动生成
    const documentId = id || `doc_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`
    const now = new Date()

    // 获取知识库默认配置
    const kb = await this.getKnowledgeBase(knowledgeBaseId)
    if (!kb) {
      throw new Error(`Knowledge base ${knowledgeBaseId} not found`)
    }

    // 如果用户提供了ID，检查ID是否已存在
    if (id) {
      const existingDoc = await this.getDocument(id)
      if (existingDoc) {
        throw new Error(`Document with id ${id} already exists`)
      }
    }

    const finalChunkStrategy = chunkStrategy || kb.defaultChunkStrategy
    const finalChunkConfig = chunkConfig || kb.defaultChunkConfig

    try {
      const [result] = await db
        .insert(documents)
        .values({
          id: documentId,
          knowledgeBaseId,
          content,
          type,
          chunkStrategy: finalChunkStrategy,
          chunkConfig: finalChunkConfig || null,
          metadata: metadata || null,
          chunkCount: 0, // 初始为0，处理后会更新
          status: 'processing', // 初始状态为 processing
          createdAt: now,
          updatedAt: now
        })
        .returning()

      if (!result) {
        throw new Error('Failed to create document: no rows inserted')
      }

      return {
        id: result.id,
        knowledgeBaseId: result.knowledgeBaseId,
        content: result.content,
        type: result.type as 'text' | 'markdown' | 'html' | 'tiptap',
        chunkStrategy: result.chunkStrategy as ChunkStrategy,
        chunkConfig: result.chunkConfig as any,
        metadata: result.metadata as Record<string, any> | undefined,
        chunkCount: result.chunkCount,
        status: (result.status as any) || 'completed', // 向后兼容：如果没有 status 字段，默认为 completed
        createdAt: result.createdAt,
        updatedAt: result.updatedAt
      }
    } catch (error: any) {
      console.error('Error creating document:', error.message)
      throw new Error(`Failed to create document: ${error.message}`)
    }
  }

  /**
   * 更新文档状态
   */
  async updateDocumentStatus(documentId: string, status: 'processing' | 'completed' | 'failed', error?: string): Promise<void> {
    try {
      const updateData: any = {
        status,
        updatedAt: new Date()
      }

      // 如果提供了错误信息，更新到 metadata
      if (error) {
        const doc = await this.getDocument(documentId)
        if (doc) {
          updateData.metadata = {
            ...(doc.metadata || {}),
            error,
            errorAt: new Date().toISOString()
          }
        }
      }

      await db.update(documents).set(updateData).where(eq(documents.id, documentId))
    } catch (error: any) {
      console.error('Error updating document status:', error.message)
      throw new Error(`Failed to update document status: ${error.message}`)
    }
  }

  /**
   * 更新文档的块数量
   */
  async updateDocumentChunkCount(documentId: string, chunkCount: number): Promise<void> {
    await db
      .update(documents)
      .set({
        chunkCount,
        updatedAt: new Date()
      })
      .where(eq(documents.id, documentId))
  }

  /**
   * 获取文档列表（支持分页、搜索、排序）
   */
  async listDocuments(
    knowledgeBaseId: string,
    options?: {
      page?: number
      pageSize?: number
      search?: string
      metadataFilter?: Record<string, any> // 元信息筛选（MongoDB 风格，复用检索 filter 语义）
      orderBy?: 'createdAt' | 'updatedAt' | 'id'
      orderDirection?: 'ASC' | 'DESC'
      status?: 'processing' | 'completed' | 'failed' | 'all' // 默认只返回 completed
    }
  ): Promise<{
    items: Document[]
    total: number
    page: number
    pageSize: number
    totalPages: number
  }> {
    const {
      page = 1,
      pageSize = 20,
      search,
      metadataFilter,
      orderBy = 'createdAt',
      orderDirection = 'DESC',
      status = 'completed'
    } = options || {}

    // 元信息筛选路径：与检索 filter 同语义（buildDeleteFilterQuery 产出参数化条件），
    // documents 与向量表同名列 metadata，直接复用转换器；走原生 SQL 保证占位符绑定正确
    if (metadataFilter && Object.keys(metadataFilter).length > 0) {
      const { buildDeleteFilterQuery } = await import('../vector/filter.js')
      const { sql: condSql, values } = buildDeleteFilterQuery(metadataFilter)
      const conditions = condSql.replace(/^WHERE /, '') || 'TRUE'
      // 占位顺序：$1..$m 为 filter 条件值（buildDeleteFilterQuery 约定），其后 knowledgeBaseId/status/search
      const kbIdx = values.length + 1
      let whereSql = `${conditions} AND knowledge_base_id = $${kbIdx}`
      const sqlParams: unknown[] = [...values, knowledgeBaseId]
      if (status !== 'all') {
        whereSql += ` AND status = $${kbIdx + 1}`
        sqlParams.push(status)
      }
      if (search && search.trim()) {
        whereSql += ` AND (id ILIKE $${sqlParams.length + 1} OR content ILIKE $${sqlParams.length + 1})`
        sqlParams.push(`%${search.trim()}%`)
      }
      const orderColumn = orderBy === 'id' ? 'id' : orderBy === 'updatedAt' ? 'updated_at' : 'created_at'
      const direction = orderDirection === 'ASC' ? 'ASC' : 'DESC'
      const limitIdx = sqlParams.length + 1
      const offsetIdx = sqlParams.length + 2
      const selectCols = `id, knowledge_base_id AS "knowledgeBaseId", content, type, chunk_strategy AS "chunkStrategy", chunk_config AS "chunkConfig", metadata, chunk_count AS "chunkCount", status, created_at AS "createdAt", updated_at AS "updatedAt"`
      const rows = await pool.query(
        `SELECT ${selectCols} FROM ${schemaName}.documents WHERE ${whereSql} ORDER BY ${orderColumn} ${direction} LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        [...sqlParams, pageSize, (page - 1) * pageSize]
      )
      const countRes = await pool.query(
        `SELECT count(*)::int AS n FROM ${schemaName}.documents WHERE ${whereSql}`,
        sqlParams
      )
      const total = countRes.rows[0]?.n || 0
      return {
        items: rows.rows as Document[],
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize)
      }
    }

    // 引入 SQL 操作符
    const { or, ilike, sql, asc, and } = await import('drizzle-orm')

    // 组合过滤条件：drizzle 的 .where() 链式调用是覆盖而非叠加，
    // 必须用 and() 合并后单次传入，否则 knowledgeBaseId 条件会被后续条件顶掉造成跨库泄漏
    const conditions: any[] = [eq(documents.knowledgeBaseId, knowledgeBaseId)]

    // 状态过滤（默认只返回 completed 状态的文档）
    if (status !== 'all') {
      conditions.push(eq(documents.status, status) as any)
    }

    // 搜索过滤（按ID或内容）
    if (search && search.trim()) {
      const searchTerm = `%${search.trim()}%`
      conditions.push(or(ilike(documents.id, searchTerm), ilike(documents.content, searchTerm)) as any)
    }

    const whereClause = and(...conditions)

    // 构建基础查询
    const query: any = db.select().from(documents).where(whereClause)

    // 获取总数（应用相同的过滤条件）
    const countQuery: any = db
      .select({ count: sql<number>`count(*)::int` })
      .from(documents)
      .where(whereClause)

    const countResult = await countQuery.execute()
    const total = countResult[0]?.count || 0

    // 构建排序
    const orderField =
      orderBy === 'id' ? documents.id : orderBy === 'updatedAt' ? documents.updatedAt : documents.createdAt

    const orderClause = orderDirection === 'ASC' ? asc(orderField) : desc(orderField)

    // 执行分页查询
    const results = await query.orderBy(orderClause).limit(pageSize).offset((page - 1) * pageSize)

    // 数据映射
    const items = results.map((row: any) => ({
      id: row.id,
      knowledgeBaseId: row.knowledgeBaseId,
      content: row.content,
      type: row.type as 'text' | 'markdown' | 'html' | 'tiptap',
      chunkStrategy: row.chunkStrategy as ChunkStrategy,
      chunkConfig: row.chunkConfig as any,
      metadata: row.metadata as Record<string, any> | undefined,
      chunkCount: row.chunkCount,
      status: (row.status as any) || 'completed', // 向后兼容
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    }))

    return {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize)
    }
  }

  /**
   * 获取文档详情
   */
  async getDocument(documentId: string): Promise<Document | null> {
    const [result] = await db.select().from(documents).where(eq(documents.id, documentId)).limit(1)

    if (!result) {
      return null
    }

    return {
      id: result.id,
      knowledgeBaseId: result.knowledgeBaseId,
      content: result.content,
      type: result.type as 'text' | 'markdown' | 'html' | 'tiptap',
      chunkStrategy: result.chunkStrategy as ChunkStrategy,
      chunkConfig: result.chunkConfig as any,
      metadata: result.metadata as Record<string, any> | undefined,
      chunkCount: result.chunkCount,
      status: (result.status as any) || 'completed', // 向后兼容
      createdAt: result.createdAt,
      updatedAt: result.updatedAt
    }
  }

  /**
   * 更新文档
   */
  async updateDocument(
    documentId: string,
    content?: string,
    type?: 'text' | 'markdown' | 'html' | 'tiptap',
    chunkStrategy?: ChunkStrategy,
    chunkConfig?: any,
    metadata?: Record<string, any>
  ): Promise<Document | null> {
    const updateData: any = {
      updatedAt: new Date()
    }

    if (content !== undefined) {
      updateData.content = content
    }
    if (type !== undefined) {
      updateData.type = type
    }
    if (chunkStrategy !== undefined) {
      updateData.chunkStrategy = chunkStrategy
    }
    if (chunkConfig !== undefined) {
      updateData.chunkConfig = chunkConfig
    }
    if (metadata !== undefined) {
      updateData.metadata = metadata
    }

    if (Object.keys(updateData).length === 1) {
      // 只有 updatedAt，直接返回
      return await this.getDocument(documentId)
    }

    await db.update(documents).set(updateData).where(eq(documents.id, documentId))

    return await this.getDocument(documentId)
  }

  /**
   * 删除文档
   */
  async deleteDocument(documentId: string): Promise<void> {
    await db.delete(documents).where(eq(documents.id, documentId))
  }

  /**
   * 清理失败状态的文档
   * @param knowledgeBaseId - 知识库ID（可选，如果提供则只清理该知识库的文档）
   * @param maxAgeHours - 最大保留时间（小时），默认 24 小时
   * @returns 清理的文档数量
   */
  async cleanupFailedDocuments(knowledgeBaseId?: string, maxAgeHours: number = 24): Promise<number> {
    try {
      const maxAge = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000)
      
      // 构建查询条件
      let query: any = db
        .select()
        .from(documents)
        .where(eq(documents.status, 'failed' as any))
      
      if (knowledgeBaseId) {
        query = query.where(eq(documents.knowledgeBaseId, knowledgeBaseId) as any)
      }
      
      const failedDocs = await query.execute()
      
      // 过滤出超过保留时间的文档
      const docsToDelete = failedDocs.filter((doc: any) => {
        const updatedAt = doc.updatedAt || doc.createdAt
        return updatedAt < maxAge
      })
      
      if (docsToDelete.length === 0) {
        return 0
      }
      
      // 删除文档和对应的向量
      let deletedCount = 0
      for (const doc of docsToDelete) {
        try {
          // 删除向量
          await this.vectorService.deleteByDocumentId(doc.knowledgeBaseId, doc.id)
          // 删除文档记录
          await db.delete(documents).where(eq(documents.id, doc.id))
          deletedCount++
        } catch (error: any) {
          console.error(`Failed to cleanup document ${doc.id}:`, error.message)
        }
      }
      
      console.log(`清理了 ${deletedCount} 个失败状态的文档`)
      return deletedCount
    } catch (error: any) {
      console.error('Error cleaning up failed documents:', error.message)
      throw new Error(`Failed to cleanup failed documents: ${error.message}`)
    }
  }

  /**
   * 确保知识库的向量索引已就绪
   * 如果索引不存在或表丢失，会自动创建
   * @param knowledgeBaseId - 知识库ID
   */
  async ensureKnowledgeBaseReady(knowledgeBaseId: string): Promise<void> {
    const kb = await this.getKnowledgeBase(knowledgeBaseId)
    if (!kb) {
      throw new Error(`Knowledge base not found: ${knowledgeBaseId}`)
    }

    // 优先使用知识库记录中存储的 indexName，如果没有则计算
    const indexName = kb.indexName || getKnowledgeBaseIndexName(knowledgeBaseId)

    // 检查向量索引表是否存在
    const { pool } = await import('../../../db/index.js')
    const checkClient = await pool.connect()
    let indexTableExists = false
    try {
      const checkResult = await checkClient.query(
        `
        SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = $1
          AND table_name = $2
        )
      `,
        [getDatabaseSchema(), indexName]
      )
      indexTableExists = checkResult.rows[0]?.exists || false
    } finally {
      checkClient.release()
    }

    // 如果记录显示已创建但表不存在，或者记录显示未创建，都需要创建索引
    if (!kb.indexCreated || !indexTableExists) {
      if (!indexTableExists && kb.indexCreated) {
        console.warn(`Index record shows created but table ${indexName} does not exist, recreating...`)
      }
      console.log(`Vector index for knowledge base ${knowledgeBaseId} does not exist, creating...`)

      // 获取向量维度（统一使用 1536）
      const dimension = getEmbeddingDimension()

      try {
        // 创建向量索引
        await this.vectorService.createIndex(knowledgeBaseId, dimension)

        // 验证索引表是否真的创建成功
        const verifyClient = await pool.connect()
        try {
          const verifyResult = await verifyClient.query(
            `
            SELECT EXISTS (
              SELECT FROM information_schema.tables
              WHERE table_schema = $1
              AND table_name = $2
            )
          `,
            [getDatabaseSchema(), indexName]
          )

          if (!verifyResult.rows[0]?.exists) {
            throw new Error(`Index table ${indexName} was not created`)
          }
        } finally {
          verifyClient.release()
        }

        // 更新知识库记录
        await db
          .update(knowledgeBases)
          .set({
            indexName,
            indexDimension: dimension,
            indexCreated: 1,
            indexCreatedAt: new Date(),
            updatedAt: new Date()
          })
          .where(eq(knowledgeBases.id, knowledgeBaseId))

        console.log(`Vector index created successfully for knowledge base ${knowledgeBaseId} (table: ${indexName})`)
      } catch (indexError: any) {
        console.error(`Failed to create vector index for ${knowledgeBaseId}:`, indexError.message)
        // 更新知识库记录为失败状态
        await db
          .update(knowledgeBases)
          .set({
            indexName,
            indexDimension: dimension,
            indexCreated: 0,
            updatedAt: new Date()
          })
          .where(eq(knowledgeBases.id, knowledgeBaseId))
        throw new Error(`Failed to create vector index: ${indexError.message}`)
      }
    }
  }

  /**
   * 获取知识库统计信息
   * @param knowledgeBaseId - 知识库ID
   * @returns 统计信息（文档数量、Chunk数量）
   */
  private async getKnowledgeBaseStats(knowledgeBaseId: string): Promise<{
    documentCount: number
    chunkCount: number
  }> {
    // 获取文档数量
    const { sql } = await import('drizzle-orm')
    const docResult = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(documents)
      .where(eq(documents.knowledgeBaseId, knowledgeBaseId))
      .execute()

    const documentCount = docResult[0]?.count || 0

    // 获取Chunk数量（从向量索引表）
    const chunkCount = await this.vectorService.countChunks(knowledgeBaseId)

    return {
      documentCount,
      chunkCount
    }
  }
}
