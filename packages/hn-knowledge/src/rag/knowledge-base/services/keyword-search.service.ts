import { Pool } from 'pg'
import { VectorService } from './vector.service'
import { ensurePgSchema } from '../../../db/ensure-schema.js'
import type { SearchResultItem } from '../types/knowledge-base.types'
import { detectLanguage, type LanguageType } from '../../../utils/language-detection'
import { getKnowledgeBaseIndexName } from '../../../utils/index-name.js'
import {
  FALLBACK_QUERY_LIMIT,
  MIN_KEYWORD_SCORE,
  SLOW_QUERY_THRESHOLD
} from '../../../config/search.constants'

// 配置选项
interface KeywordSearchConfig {
  enablePgBigm?: boolean // 是否启用 pg_bigm 扩展
  enableEnglishTSVector?: boolean // 是否创建英文 tsvector 索引
  chineseSimilarityThreshold?: {
    short?: number // 1-2字
    medium?: number // 3-5字
    long?: number // >5字
  }
  englishSimilarityThreshold?: {
    short?: number // <3字符
    medium?: number // 3-10字符
    long?: number // >10字符
  }
  slowQueryThreshold?: number // 慢查询阈值（毫秒）
}

// 增强的过滤选项
interface EnhancedFilterOptions {
  docPathPrefix?: string // 文档路径前缀过滤（如 "教程/快速开始"）
  parentPath?: string // 父级路径精确匹配
  brandCode?: string // 品牌代码
  languageCode?: string // 语言代码
  [key: string]: any // 其他任意字段过滤
}

const DEFAULT_CONFIG: Required<KeywordSearchConfig> = {
  enablePgBigm: process.env.ENABLE_PG_BIGM !== 'false', // 默认启用
  enableEnglishTSVector: process.env.ENABLE_ENGLISH_TSVECTOR !== 'false', // 默认启用
  chineseSimilarityThreshold: {
    short: parseFloat(process.env.CHINESE_SIMILARITY_SHORT || '0.5'),
    medium: parseFloat(process.env.CHINESE_SIMILARITY_MEDIUM || '0.25'),
    long: parseFloat(process.env.CHINESE_SIMILARITY_LONG || '0.15')
  },
  englishSimilarityThreshold: {
    short: parseFloat(process.env.ENGLISH_SIMILARITY_SHORT || '0.4'),
    medium: parseFloat(process.env.ENGLISH_SIMILARITY_MEDIUM || '0.2'),
    long: parseFloat(process.env.ENGLISH_SIMILARITY_LONG || '0.1')
  },
  slowQueryThreshold: parseInt(process.env.SLOW_QUERY_THRESHOLD || '100', 10)
}

export class KeywordSearchService {
  private pool: Pool
  private vectorService: VectorService
  private schemaName: string
  private config: Required<KeywordSearchConfig>
  private pgBigmAvailable: boolean = false
  /** 由 database API 注入的物理表名，避免查询 knowledge_bases */
  private indexNamePinned: Map<string, string> = new Map()

  constructor(
    connectionString: string,
    vectorService: VectorService,
    schemaName: string = 'test',
    config?: KeywordSearchConfig
  ) {
    this.pool = new Pool({ connectionString })
    this.vectorService = vectorService
    this.schemaName = schemaName
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.initFullTextSearch()
  }

  /**
   * 解析向量表名：knowledge_bases 中的 index_name，否则计算名；关系型数据集应先 primeIndexNameCache。
   */
  private async getIndexName(datasetId: string): Promise<string> {
    const pinned = this.indexNamePinned.get(datasetId)
    if (pinned) return pinned

    const client = await this.pool.connect()
    try {
      await client.query(`SET search_path TO ${this.schemaName}, public`)
      const kb = await client.query(
        `SELECT index_name FROM ${this.schemaName}.knowledge_bases WHERE id = $1 LIMIT 1`,
        [datasetId]
      )
      if (kb.rows[0]?.index_name) {
        return kb.rows[0].index_name as string
      }
    } catch (e: any) {
      console.warn(`getIndexName: could not read index_name for ${datasetId}, using computed name:`, e.message)
    } finally {
      client.release()
    }
    return getKnowledgeBaseIndexName(datasetId)
  }

  /**
   * 由 database API 在关键词检索前注入物理表名，避免本服务查询其它业务域表。
   */
  primeIndexNameCache(datasetId: string, indexName: string): void {
    this.indexNamePinned.set(datasetId, indexName)
  }

  /**
   * 初始化全文搜索（使用 PostgreSQL 的 pg_trgm 和 pg_bigm）
   */
  private async initFullTextSearch() {
    const client = await this.pool.connect()
    try {
      // 创建 schema（如果不存在）
      await ensurePgSchema(client, this.schemaName)
      // 确保 pg_trgm 扩展已安装（用于相似度搜索）
      await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA public')

      // 尝试安装 pg_bigm 扩展（中文支持）
      if (this.config.enablePgBigm) {
        try {
          await client.query('CREATE EXTENSION IF NOT EXISTS pg_bigm SCHEMA public')
          this.pgBigmAvailable = true
          console.log('pg_bigm extension enabled for Chinese text search')
        } catch (error: any) {
          console.warn('pg_bigm extension not available, falling back to trigram:', error.message)
          this.pgBigmAvailable = false
        }
      }
    } finally {
      client.release()
    }
  }

  /**
   * 自动为向量表创建多语言性能优化索引
   * 在知识库初始化时自动调用，无需手动调用
   *
   * 索引策略：
   * - 必需：GIN trigram 索引（中英文通用）
   * - 可选：英文 tsvector 索引（如果启用）
   * - 不建议：中文 tsvector 索引（trigram 已足够）
   */
  async createPerformanceIndexes(knowledgeBaseId: string): Promise<void> {
    const client = await this.pool.connect()
    const startTime = Date.now()
    try {
      await client.query(`SET search_path TO ${this.schemaName}, public`)
      const indexName = await this.getIndexName(knowledgeBaseId)

      // 检查表是否存在
      const tableExists = await client.query(
        `SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = $1 
          AND table_name = $2
        )`,
        [this.schemaName, indexName]
      )

      if (!tableExists.rows[0]?.exists) {
        console.warn(`Vector table ${this.schemaName}.${indexName} does not exist, skipping index creation`)
        return
      }

      // 1. 必需：为 metadata->>'text' 创建 GIN trigram 索引（中英文通用）
      // 使用 CONCURRENTLY 避免锁表，添加索引参数优化
      try {
        await client.query(`
          CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_${indexName}_text_trgm 
          ON ${this.schemaName}.${indexName} 
          USING GIN ((metadata->>'text') gin_trgm_ops)
          WITH (fastupdate = off)
          WHERE metadata->>'text' IS NOT NULL
        `)
        console.log(`Created GIN trigram index for ${indexName} text field`)
      } catch (error: any) {
        // CONCURRENTLY 不能在事务中使用，如果失败则尝试普通创建
        if (error.message?.includes('CONCURRENTLY')) {
          try {
            await client.query(`
              CREATE INDEX IF NOT EXISTS idx_${indexName}_text_trgm 
              ON ${this.schemaName}.${indexName} 
              USING GIN ((metadata->>'text') gin_trgm_ops)
              WITH (fastupdate = off)
              WHERE metadata->>'text' IS NOT NULL
            `)
            console.log(`Created GIN trigram index for ${indexName} text field (non-concurrent)`)
          } catch (retryError: any) {
            console.warn(`Failed to create GIN trigram index for ${indexName}:`, retryError.message)
          }
        } else {
          console.warn(`Failed to create GIN trigram index for ${indexName}:`, error.message)
        }
      }

      // 2. 可选：为 metadata->>'text' 创建英文 tsvector 索引（如果启用）
      if (this.config.enableEnglishTSVector) {
        try {
          await client.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_${indexName}_text_tsvector_en 
            ON ${this.schemaName}.${indexName} 
            USING GIN (to_tsvector('english', metadata->>'text'))
            WITH (fastupdate = off)
            WHERE metadata->>'text' IS NOT NULL
          `)
          console.log(`Created English tsvector index for ${indexName} text field`)
        } catch (error: any) {
          if (error.message?.includes('CONCURRENTLY')) {
            try {
              await client.query(`
                CREATE INDEX IF NOT EXISTS idx_${indexName}_text_tsvector_en 
                ON ${this.schemaName}.${indexName} 
                USING GIN (to_tsvector('english', metadata->>'text'))
                WITH (fastupdate = off)
                WHERE metadata->>'text' IS NOT NULL
              `)
              console.log(`Created English tsvector index for ${indexName} text field (non-concurrent)`)
            } catch (retryError: any) {
              console.warn(`Failed to create English tsvector index for ${indexName}:`, retryError.message)
            }
          } else {
            console.warn(`Failed to create English tsvector index for ${indexName}:`, error.message)
          }
        }
      }

      // 3. 为 metadata->>'documentId' 创建 B-tree 索引（用于过滤）
      try {
        await client.query(`
          CREATE INDEX IF NOT EXISTS idx_${indexName}_document_id 
          ON ${this.schemaName}.${indexName} 
          ((metadata->>'documentId'))
        `)
        console.log(`Created B-tree index for ${indexName} documentId field`)
      } catch (error: any) {
        console.warn(`Failed to create B-tree index for ${indexName} documentId:`, error.message)
      }

      const duration = Date.now() - startTime
      if (duration > this.config.slowQueryThreshold) {
        console.warn(`Slow index creation for ${indexName}: ${duration}ms`)
      }
    } finally {
      client.release()
    }
  }

  /**
   * 获取动态相似度阈值（根据语言和查询长度）
   */
  private getSimilarityThreshold(language: LanguageType, queryLength: number): number {
    if (language === 'zh') {
      if (queryLength <= 2) {
        return this.config.chineseSimilarityThreshold.short!
      } else if (queryLength <= 5) {
        return this.config.chineseSimilarityThreshold.medium!
      } else {
        return this.config.chineseSimilarityThreshold.long!
      }
    } else if (language === 'en') {
      if (queryLength < 3) {
        return this.config.englishSimilarityThreshold.short!
      } else if (queryLength <= 10) {
        return this.config.englishSimilarityThreshold.medium!
      } else {
        return this.config.englishSimilarityThreshold.long!
      }
    } else {
      // 混合语言：使用较低阈值
      return Math.min(this.config.chineseSimilarityThreshold.medium!, this.config.englishSimilarityThreshold.medium!)
    }
  }

  /**
   * 查询重写：清理和规范化查询文本
   */
  private rewriteQuery(query: string, language: LanguageType): string {
    let rewritten = query.trim()

    // 去除前后空格
    rewritten = rewritten.replace(/^\s+|\s+$/g, '')

    if (language === 'zh') {
      // 中文处理：去除标点符号，保留所有字符
      rewritten = rewritten.replace(/[，。！？；：、""''（）【】《》]/g, ' ')
      // 去除多余空格
      rewritten = rewritten.replace(/\s+/g, ' ')
    } else if (language === 'en') {
      // 英文处理：去除常见停用词（简单版本）
      const stopWords = ['a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being']
      const words = rewritten.toLowerCase().split(/\s+/)
      rewritten = words.filter((word) => word.length > 1 && !stopWords.includes(word)).join(' ')
    } else {
      // 混合语言：去除标点，保留所有字符
      rewritten = rewritten.replace(/[，。！？；：、""''（）【】《》,.!?;:""''()\[\]<>]/g, ' ')
      rewritten = rewritten.replace(/\s+/g, ' ')
    }

    return rewritten.trim()
  }

  /**
   * 构建增强的过滤条件（支持路径前缀等）
   */
  private buildEnhancedFilterConditions(
    filter?: Record<string, any>
  ): { conditions: string[]; params: any[] } {
    const conditions: string[] = []
    const params: any[] = []

    if (!filter) {
      return { conditions: [], params }
    }

    for (const [key, value] of Object.entries(filter)) {
      // 特殊处理路径前缀过滤
      if (key === 'docPathPrefix' && value) {
        // 使用前缀匹配：docPath 以 value 开头
        conditions.push(`metadata->>'docPath' LIKE $${params.length + 1}`)
        params.push(`${value}%`)
        continue
      }

      // 特殊处理 parentPath（虽然也可以作为普通字段，但明确处理更清晰）
      if (key === 'parentPath' && value) {
        conditions.push(`metadata->>'parentPath' = $${params.length + 1}`)
        params.push(value)
        continue
      }

      // 处理嵌套的 metadata 字段（如 metadata.source）
      if (key.includes('.')) {
        const parts = key.split('.')
        let path = 'metadata'
        for (let i = 0; i < parts.length; i++) {
          if (i === parts.length - 1) {
            path += `->>'${parts[i]}'`
          } else {
            path += `->'${parts[i]}'`
          }
        }
        conditions.push(`${path} = $${params.length + 1}`)
        params.push(value)
      } else {
        // 普通字段
        conditions.push(`metadata->>'${key}' = $${params.length + 1}`)
        params.push(value)
      }
    }

    return { conditions, params }
  }

  /**
   * 关键词搜索（使用文本匹配和 pg_trgm 相似度搜索）
   * 优化：支持多语言、动态相似度阈值、查询重写、路径前缀过滤
   */
  async search(
    knowledgeBaseId: string,
    query: string,
    topK: number = 10,
    filter?: Record<string, any>
  ): Promise<SearchResultItem[]> {
    const startTime = Date.now()
    const client = await this.pool.connect()

    try {
      // 语言检测和查询重写
      const langResult = detectLanguage(query)
      const rewrittenQuery = this.rewriteQuery(query, langResult.language)
      const queryLength = rewrittenQuery.length
      const similarityThreshold = this.getSimilarityThreshold(langResult.language, queryLength)

      // 记录查询信息（用于监控）
      const queryInfo = {
        language: langResult.language,
        originalQuery: query,
        rewrittenQuery,
        similarityThreshold,
        queryLength
      }

      await client.query(`SET search_path TO ${this.schemaName}, public`)
      const indexName = await this.getIndexName(knowledgeBaseId)

      // 检查表是否存在
      const tableExists = await client.query(
        `SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = $1 
          AND table_name = $2
        )`,
        [this.schemaName, indexName]
      )

      if (!tableExists.rows[0]?.exists) {
        console.warn(`Vector table ${this.schemaName}.${indexName} does not exist`)
        return []
      }

      // 构建过滤条件（使用增强的过滤器）
      const { conditions: filterConditionList, params: filterParams } =
        this.buildEnhancedFilterConditions(filter)
      const filterConditions =
        filterConditionList.length > 0 ? ' AND ' + filterConditionList.join(' AND ') : ''

      // 使用重写后的查询和动态阈值
      const searchPattern = `%${rewrittenQuery}%`
      const queryParams = [...filterParams, searchPattern, rewrittenQuery, similarityThreshold, topK]

      const searchQuery = `
        SELECT
          vector_id as id,
          metadata->>'text' as text,
          metadata,
          CASE
            -- 路径或文档名完全匹配（最高优先级）
            WHEN metadata->>'docPath' ILIKE $${filterParams.length + 1}
              OR metadata->>'docName' ILIKE $${filterParams.length + 1}
            THEN 1.5
            -- 文本内容完全匹配（包含查询词）
            WHEN metadata->>'text' ILIKE $${filterParams.length + 1} THEN 1.0
            -- 使用 pg_trgm 相似度（动态阈值）
            WHEN similarity(metadata->>'text', $${filterParams.length + 2}) > $${filterParams.length + 3}
            THEN similarity(metadata->>'text', $${filterParams.length + 2})
            ELSE 0
          END as similarity_score
        FROM ${this.schemaName}.${indexName}
        WHERE metadata->>'text' IS NOT NULL
          AND (
            metadata->>'text' ILIKE $${filterParams.length + 1}
            OR metadata->>'docPath' ILIKE $${filterParams.length + 1}
            OR metadata->>'docName' ILIKE $${filterParams.length + 1}
            OR similarity(metadata->>'text', $${filterParams.length + 2}) > $${filterParams.length + 3}
          )
        ${filterConditions}
        ORDER BY
          -- 优先显示路径/文档名匹配的结果
          CASE
            WHEN metadata->>'docPath' ILIKE $${filterParams.length + 1}
              OR metadata->>'docName' ILIKE $${filterParams.length + 1}
            THEN 0
            ELSE 1
          END,
          -- 然后按相似度排序
          similarity_score DESC
        LIMIT $${filterParams.length + 4}
      `

      const result = await client.query(searchQuery, queryParams)

      // 格式化结果
      const results: SearchResultItem[] = result.rows.map((row) => {
        const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata
        return {
          id: row.id,
          text: row.text || '',
          score: parseFloat(row.similarity_score || '0'),
          metadata: metadata || {},
          documentId: metadata?.documentId || '',
          chunkIndex: metadata?.chunkIndex
        }
      })

      // 监控：记录查询性能
      const duration = Date.now() - startTime
      if (duration > this.config.slowQueryThreshold) {
        console.warn(`Slow query detected (${duration}ms):`, {
          knowledgeBaseId,
          ...queryInfo,
          resultCount: results.length
        })
      }

      return results
    } catch (error: any) {
      // 第一个回退逻辑：使用简化的查询方法
      try {
        await client.query(`SET search_path TO ${this.schemaName}, public`)
        const indexName = getKnowledgeBaseIndexName(knowledgeBaseId)

        // 检查表是否存在
        const tableExists = await client.query(
          `SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = $1 
          AND table_name = $2
        )`,
          [this.schemaName, indexName]
        )

        if (!tableExists.rows[0]?.exists) {
          console.warn(`Vector table ${this.schemaName}.${indexName} does not exist`)
          return []
        }

        // 构建过滤条件（使用增强的过滤器）
        const { conditions: filterConditionList, params: filterParams } =
          this.buildEnhancedFilterConditions(filter)
        const filterConditions =
          filterConditionList.length > 0 ? ' AND ' + filterConditionList.join(' AND ') : ''

        // 优化后的查询：使用更高效的文本搜索
        // 1. 优先使用 ILIKE 进行精确匹配（最高分）
        // 2. 使用 pg_trgm 相似度搜索作为补充
        // 3. 使用 GIN 索引（如果存在）加速搜索
        const searchPattern = `%${query}%`
        const queryParams = [...filterParams, searchPattern, query, topK]

        const searchQuery = `
        SELECT
          vector_id as id,
          metadata->>'text' as text,
          metadata,
          CASE
            -- 路径或文档名完全匹配（最高优先级）
            WHEN metadata->>'docPath' ILIKE $${filterParams.length + 1}
              OR metadata->>'docName' ILIKE $${filterParams.length + 1}
            THEN 1.5
            -- 文本内容完全匹配（包含查询词）
            WHEN metadata->>'text' ILIKE $${filterParams.length + 1} THEN 1.0
            -- 使用 pg_trgm 相似度（阈值 0.1）
            WHEN similarity(metadata->>'text', $${filterParams.length + 2}) > 0.1
            THEN similarity(metadata->>'text', $${filterParams.length + 2})
            ELSE 0
          END as similarity_score
        FROM ${this.schemaName}.${indexName}
        WHERE metadata->>'text' IS NOT NULL
          AND (
            metadata->>'text' ILIKE $${filterParams.length + 1}
            OR metadata->>'docPath' ILIKE $${filterParams.length + 1}
            OR metadata->>'docName' ILIKE $${filterParams.length + 1}
            OR similarity(metadata->>'text', $${filterParams.length + 2}) > 0.1
          )
        ${filterConditions}
        ORDER BY
          -- 优先显示路径/文档名匹配的结果
          CASE
            WHEN metadata->>'docPath' ILIKE $${filterParams.length + 1}
              OR metadata->>'docName' ILIKE $${filterParams.length + 1}
            THEN 0
            ELSE 1
          END,
          -- 然后按相似度排序
          similarity_score DESC
        LIMIT $${filterParams.length + 3}
      `

        const result = await client.query(searchQuery, queryParams)

        // 格式化结果
        const results: SearchResultItem[] = result.rows.map((row) => {
          const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata
          return {
            id: row.id,
            text: row.text || '',
            score: parseFloat(row.similarity_score || '0'),
            metadata: metadata || {},
            documentId: metadata?.documentId || '',
            chunkIndex: metadata?.chunkIndex
          }
        })

        return results
      } catch (error: any) {
        // 优化后的回退逻辑：使用更简单高效的方法
        console.warn('Direct vector table query failed, using fallback method:', error.message)

        // 优化后的回退方法：使用简化的相似度搜索，避免内存爆炸
        try {
          const indexName = getKnowledgeBaseIndexName(knowledgeBaseId)

          // 构建过滤条件
          const { conditions: filterConditionList, params: filterParams } =
            this.buildEnhancedFilterConditions(filter)
          const filterConditions =
            filterConditionList.length > 0 ? ' AND ' + filterConditionList.join(' AND ') : ''

          // 使用简化的相似度搜索，限制结果数量
          const searchPattern = `%${query}%`
          const queryParams = [...filterParams, searchPattern, MIN_KEYWORD_SCORE, topK]

          const simplifiedQuery = `
            SELECT
              vector_id as id,
              metadata->>'text' as text,
              metadata,
              CASE
                WHEN metadata->>'text' ILIKE $${filterParams.length + 1} THEN 1.0
                ELSE similarity(metadata->>'text', $${filterParams.length + 1})
              END as similarity_score
            FROM ${this.schemaName}.${indexName}
            WHERE metadata->>'text' IS NOT NULL
              AND (
                metadata->>'text' ILIKE $${filterParams.length + 1}
                OR similarity(metadata->>'text', $${filterParams.length + 1}) > $${filterParams.length + 2}
              )
              ${filterConditions}
            ORDER BY similarity_score DESC
            LIMIT $${filterParams.length + 3}
          `

          const result = await client.query(simplifiedQuery, queryParams)

          // 格式化结果
          const results: SearchResultItem[] = result.rows.map((row) => {
            const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata
            return {
              id: row.id,
              text: row.text || '',
              score: parseFloat(row.similarity_score || '0'),
              metadata: metadata || {},
              documentId: metadata?.documentId || '',
              chunkIndex: metadata?.chunkIndex
            }
          })

          return results
        } catch (fallbackError: any) {
          console.error('Simplified fallback also failed:', fallbackError.message)
          // 最后的回退：只使用 ILIKE 搜索（不计算相似度）
          try {
            const indexName = getKnowledgeBaseIndexName(knowledgeBaseId)

            // 构建过滤条件
            const { conditions: filterConditionList, params: filterParams } =
              this.buildEnhancedFilterConditions(filter)
            const filterConditions =
              filterConditionList.length > 0 ? ' AND ' + filterConditionList.join(' AND ') : ''

            const searchPattern = `%${query}%`
            const queryParams = [...filterParams, searchPattern, topK]

            const ilikeOnlyQuery = `
              SELECT
                vector_id as id,
                metadata->>'text' as text,
                metadata,
                1.0 as similarity_score
              FROM ${this.schemaName}.${indexName}
              WHERE metadata->>'text' IS NOT NULL
                AND metadata->>'text' ILIKE $${filterParams.length + 1}
                ${filterConditions}
              LIMIT $${filterParams.length + 2}
            `

            const result = await client.query(ilikeOnlyQuery, queryParams)

            const results: SearchResultItem[] = result.rows.map((row) => {
              const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata
              return {
                id: row.id,
                text: row.text || '',
                score: 1.0,
                metadata: metadata || {},
                documentId: metadata?.documentId || '',
                chunkIndex: metadata?.chunkIndex
              }
            })

            return results
          } catch (finalError: any) {
            console.error('All fallback methods failed:', finalError.message)
            return []
          }
        }
      }
    } finally {
      client.release()
    }
  }

  /**
   * 使用 tsvector 进行全文搜索（更精确，支持多语言）
   * 优化：支持中文（pg_bigm/simple）和英文（english）配置
   */
  async searchWithTSVector(
    knowledgeBaseId: string,
    query: string,
    topK: number = 10,
    filter?: Record<string, any>
  ): Promise<SearchResultItem[]> {
    const startTime = Date.now()
    const client = await this.pool.connect()
    try {
      // 语言检测
      const langResult = detectLanguage(query)
      const rewrittenQuery = this.rewriteQuery(query, langResult.language)

      // 根据语言选择配置
      let tsConfig: string
      if (langResult.language === 'zh') {
        // 中文：优先使用 pg_bigm，否则使用 simple
        tsConfig = this.pgBigmAvailable ? 'pg_bigm' : 'simple'
      } else if (langResult.language === 'en') {
        // 英文：使用 english 配置
        tsConfig = 'english'
      } else {
        // 混合语言：使用 simple 配置（语言无关）
        tsConfig = 'simple'
      }

      await client.query(`SET search_path TO ${this.schemaName}, public`)
      const indexName = await this.getIndexName(knowledgeBaseId)

      // 检查表是否存在
      const tableExists = await client.query(
        `SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = $1 
          AND table_name = $2
        )`,
        [this.schemaName, indexName]
      )

      if (!tableExists.rows[0]?.exists) {
        console.warn(`Vector table ${this.schemaName}.${indexName} does not exist`)
        return []
      }

      // 将查询转换为 tsquery（转义特殊字符）
      // 对于中文，pg_bigm 会自动处理分词
      let escapedQuery: string
      if (tsConfig === 'pg_bigm' || tsConfig === 'simple') {
        // 中文或 simple：直接使用查询文本，pg_bigm 会自动处理
        escapedQuery = rewrittenQuery
          .replace(/[&|!():]/g, ' ')
          .split(/\s+/)
          .map((token) => token.trim())
          .filter((token) => token.length > 0)
          .join(' & ')
      } else {
        // 英文：标准 tsquery 格式
        escapedQuery = rewrittenQuery
          .replace(/[&|!():]/g, ' ')
          .split(/\s+/)
          .map((token) => token.trim())
          .filter((token) => token.length > 0)
          .join(' & ')
      }

      if (!escapedQuery) {
        return []
      }

      // 构建过滤条件（使用增强的过滤器）
      const { conditions: filterConditionList, params: filterParams } =
        this.buildEnhancedFilterConditions(filter)
      const filterConditions =
        filterConditionList.length > 0 ? ' AND ' + filterConditionList.join(' AND ') : ''

      // 优化后的查询：使用多语言配置的 tsvector 和 tsquery
      // 使用 ts_rank_cd（覆盖密度排名）获得更好的排名
      const searchQuery = `
        SELECT 
          vector_id as id,
          metadata->>'text' as text,
          metadata,
          ts_rank_cd(
            to_tsvector($${filterParams.length + 1}, metadata->>'text'),
            to_tsquery($${filterParams.length + 1}, $${filterParams.length + 2})
          ) as rank
        FROM ${this.schemaName}.${indexName}
        WHERE metadata->>'text' IS NOT NULL
          AND to_tsvector($${filterParams.length + 1}, metadata->>'text') @@ to_tsquery($${filterParams.length + 1}, $${
        filterParams.length + 2
      })
        ${filterConditions}
        ORDER BY rank DESC
        LIMIT $${filterParams.length + 3}
      `

      const queryParams = [...filterParams, tsConfig, escapedQuery, topK]
      const result = await client.query(searchQuery, queryParams)

      // 格式化结果
      const results = result.rows.map((row) => {
        const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata
        return {
          id: row.id,
          text: row.text || '',
          score: parseFloat(row.rank || '0'),
          metadata: metadata || {},
          documentId: metadata?.documentId || '',
          chunkIndex: metadata?.chunkIndex
        }
      })

      // 监控：记录查询性能
      const duration = Date.now() - startTime
      if (duration > this.config.slowQueryThreshold) {
        console.warn(`Slow tsvector query detected (${duration}ms):`, {
          knowledgeBaseId,
          language: langResult.language,
          tsConfig,
          query: rewrittenQuery,
          resultCount: results.length
        })
      }

      return results
    } catch (error: any) {
      console.warn('TSVector search failed:', error.message)
      // 如果 tsvector 搜索失败，回退到普通的关键词搜索
      return this.search(knowledgeBaseId, query, topK, filter)
    } finally {
      client.release()
    }
  }
}
