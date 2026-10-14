/**
 * WikiCompilerService：按来源变化规划全来源知识页，生成草稿后原子发布。
 *
 * 编译流程：
 * 1. 获取或创建 Wiki 集合
 * 2. 检查编译锁定
 * 3. 创建编译任务记录
 * 4. 后台异步执行编译（不阻塞，立即返回 taskId）
 */

import { createHash } from 'crypto'
import { generateText } from 'ai'
import { openaiChat } from '../../providers/llm.js'
import { getDefaultChatModel } from '../../config/env.js'
import { db, pool, schemaName, wikiCollections, wikiConcepts, wikiConceptSources, wikiCompileTasks, wikiPageRevisions, documents, wikiRelationships } from '../db/index.js'
import { eq, and, inArray, or, sql, desc } from 'drizzle-orm'
import { buildCompilationPlan, type CompilationTarget, type CompilationDocument } from './wiki-compilation-plan.js'
import { buildSourceManifest, formatSourceManifest, formatSourceManifestsForModel, materializePageContent, validatePageProvenance, WikiProvenanceError, type WikiSourceManifest } from './wiki-provenance.js'
import { DEFAULT_WIKI_SCHEMA, type WikiSchemaConfig } from './wiki-schema.service.js'
import { tiptapToMarkdownLLM } from '../../utils/tiptap-to-markdown-llm.js'
import { tiptapToMarkdown } from '../../utils/tiptap-to-markdown.js'
import { WikiCollectionService } from './wiki-collection.service.js'
import {
  buildExtractionPrompt,
  parseAndValidateExtraction,
  buildRelationExtractionPrompt,
  parseAndValidateRelations,
  buildPagePrompt,
  parseRawPageContent,
  conceptToSlug,
  type ExtractedConcept,
  type ConceptRelation,
} from './wiki-prompts.js'
import type { WikiCompileTask, WikiCompileProgress, WikiCompileTaskStatus, WikiCompilePhase, WikiEvidence } from '../types/wiki.types.js'

/** 概念抽取失败的可分类原因：截断（推理耗尽输出预算）、无结构化输出、结构或 JSON 不合法 */
export type ExtractionFailureReason = 'llm_error' | 'truncated' | 'no_json' | 'invalid_output'

/** 页面草稿失败的可分类记录：区分输出截断与格式问题，供任务 warnings 与日志观测。 */
export interface PageDraftFailure {
  reason: 'truncated' | 'no_json' | 'invalid_output'
  finishReason?: string
  outputTokens?: number
  reasoningTokens?: number
  textLength: number
}

/** 供应商限流（429/1302/速率限制文案）不是内容失败：应立即中断批次并等待配额恢复，而不是耗尽全部重试。 */
export function isRateLimitError(error: unknown): boolean {
  const seen = new Set<unknown>()
  const check = (value: unknown): boolean => {
    if (!value || typeof value !== 'object' || seen.has(value)) return false
    seen.add(value)
    const e = value as { message?: string; statusCode?: number; data?: { error?: { code?: string | number } }; cause?: unknown; errors?: unknown[] }
    const text = String(e.message || '').toLowerCase()
    if (text.includes('速率限制') || text.includes('rate limit')) return true
    if (e.statusCode === 429) return true
    if (String(e.data?.error?.code ?? '') === '1302') return true
    if (Array.isArray(e.errors)) return e.errors.some(check)
    return check(e.cause)
  }
  return check(error)
}

/**
 * 页面/提取并发基数。不再按 attempt 递减：限流场景已由 isRateLimitError 快速失败与任务级中断保护
 * （glm-4.6 时代的递减逻辑在配额充足的渠道上只会让重试越跑越慢）。
 */
export function resolveConcurrency(base: number, _attempt: number): number {
  return Math.max(1, base)
}

/**
 * 部分发布判定：小批量（<10 页）不容忍失败（保护初期库与测试语义）；
 * 达到规模后容忍 ≤5% 的顽固失败页（真实模型对个别概念可能持续输出无效正文），
 * 失败概念标记 failed、不产新修订，其余页面正常发布。系统性失败（限流等）由快速失败先行拦截。
 */
export function allowPartialPublish(attempted: number, failed: number): boolean {
  return attempted >= 10 && failed <= Math.floor(attempted * 0.05)
}

export interface ExtractionFailure {
  reason: ExtractionFailureReason
  attempt: number
  finishReason?: string
  outputTokens?: number
  reasoningTokens?: number
  textLength: number
}

/** 用户可编辑 schema 的概念上限截断：超出上限保留前 N 个（提示词已同步要求）。 */
function capConcepts(concepts: ExtractedConcept[], maxConcepts?: number): ExtractedConcept[] {
  if (maxConcepts === undefined || maxConcepts >= 20 || concepts.length <= maxConcepts) return concepts
  console.warn(`[WikiCompiler] 概念数 ${concepts.length} 超过 schema 上限 ${maxConcepts}，截断保留前 ${maxConcepts} 个`)
  return concepts.slice(0, maxConcepts)
}

/** db 与事务 tx 可互换的查询执行器 */
type QueryRunner = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]

export class WikiCompilerService {
  private static readonly EXTRACTION_MAX_TOKENS = 8000
  private static readonly RELATION_MAX_TOKENS = 1500
  private static readonly MAX_SOURCE_CHARS = 30000
  private static readonly LEASE_SECONDS = 60
  private static readonly MAX_ATTEMPTS = 5
  /** 页面生成默认并发：真实运行中并发 5 会触发供应商限流（1302），默认降为 2，可用 WIKI_PAGE_GEN_CONCURRENCY 覆盖。 */
  static readonly DEFAULT_PAGE_CONCURRENCY = 2
  /** 页面输出预算：页面正文 + 逐字引文 claims 是长输出，且推理模型先消耗推理 token（实测 3000 下被截断）。 */
  static readonly PAGE_GEN_MAX_TOKENS = 12000
  /** 单次调用超时（毫秒）：长输出（页面 12000 token）生成耗时可数分钟，须显式加长，避免默认超时中断。 */
  static readonly LLM_TIMEOUT_MS = 600_000
  private static readonly workerId = `wiki-worker-${process.env.HOSTNAME || 'pod'}-${process.pid}-${Math.random().toString(36).slice(2, 10)}`
  private readonly locallyClaimed = new Set<string>()
  private readonly claimTokens = new Map<string, string>()
  private readonly extractionFailures = new Map<string, ExtractionFailure>()
  private readonly pageFailures = new Map<string, PageDraftFailure>()
  private recoveryTimer?: ReturnType<typeof setInterval>

  constructor(
    private wikiCollectionService: WikiCollectionService,
    private readonly workerId = WikiCompilerService.workerId,
  ) {}

  // ─── ID 生成器 ───────────────────────────────────────────────────────────────

  private generateTaskId(): string {
    return `wiki_task_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`
  }

  private generateConceptId(): string {
    return `wiki_concept_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`
  }

  private generateSourceId(): string {
    return `wiki_src_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`
  }

  // ─── 哈希计算 ────────────────────────────────────────────────────────────────

  private calculateHash(content: string): string {
    return createHash('sha256').update(content).digest('hex')
  }

  // ─── 公开 API ────────────────────────────────────────────────────────────────

  /**
   * 触发知识库的 Wiki 编译（Phase 1：概念提取）
   * 立即返回编译任务 ID，编译在后台异步执行
   */
  async compileKnowledgeBase(knowledgeBaseId: string): Promise<string> {
    const collection = await this.wikiCollectionService.getOrCreateCollection(knowledgeBaseId)
    return this.enqueueCompile(collection.id, knowledgeBaseId, undefined, {
      total: 0,
      processed: 0,
      skipped: 0,
      failed: 0,
      extracted: 0
    })
  }

  async compileDocument(knowledgeBaseId: string, documentId: string): Promise<string> {
    const [doc] = await db
      .select()
      .from(documents)
      .where(and(eq(documents.id, documentId), eq(documents.knowledgeBaseId, knowledgeBaseId)))
      .limit(1)

    if (!doc) {
      throw new Error(`Document ${documentId} not found in knowledge base ${knowledgeBaseId}`)
    }

    const collection = await this.wikiCollectionService.getOrCreateCollection(knowledgeBaseId)
    return this.enqueueCompile(collection.id, knowledgeBaseId, documentId,
      { total: 1, processed: 0, skipped: 0, failed: 0, extracted: 0 })
  }

  private async enqueueCompile(collectionId: string, knowledgeBaseId: string, documentId: string | undefined,
    progress: WikiCompileProgress): Promise<string> {
    const client = await pool.connect()
    const taskId = this.generateTaskId()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [collectionId])
      const active = await client.query(`SELECT id FROM ${schemaName}.wiki_compile_tasks
        WHERE collection_id=$1 AND status IN ('pending','running')
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [collectionId])
      if (active.rowCount) throw new Error(`Knowledge base ${knowledgeBaseId} already has a running compile task. Please wait for it to complete.`)
      await client.query(`INSERT INTO ${schemaName}.wiki_compile_tasks
        (id,collection_id,knowledge_base_id,document_id,status,progress,started_at,created_at,updated_at)
        VALUES($1,$2,$3,$4,'pending',$5,NOW(),NOW(),NOW())`,
      [taskId, collectionId, knowledgeBaseId, documentId ?? null, JSON.stringify(progress)])
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally { client.release() }
    void this.claimTask(taskId)
    return taskId
  }

  /** 每个 pod 扫描可领取任务；任务数据只依赖 PG，可在任意 pod 恢复。 */
  startRecovery(): void {
    if (this.recoveryTimer) return
    const recover = () => {
      void this.recoverAvailableTasks().catch(error => {
        console.error('[WikiCompiler] task recovery failed:', error)
      })
    }
    recover()
    this.recoveryTimer = setInterval(recover, 15000)
    this.recoveryTimer.unref?.()
  }

  stopRecovery(): void {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer)
    this.recoveryTimer = undefined
  }

  async recoverAvailableTasks(): Promise<void> {
    // 超过重试上限的过期任务直接判失败，避免毒丸任务被恢复器无限接管。
    await pool.query(`UPDATE ${schemaName}.wiki_compile_tasks SET status='failed',
      error='Max compile attempts exceeded',completed_at=NOW(),updated_at=NOW(),
      lease_expires_at=NULL,heartbeat_at=NULL
      WHERE status='running' AND lease_expires_at < NOW() AND attempt >= $1`,
      [WikiCompilerService.MAX_ATTEMPTS])
    const result = await pool.query(`SELECT id FROM ${schemaName}.wiki_compile_tasks
      WHERE status='pending' OR (status='running' AND lease_expires_at < NOW())
      ORDER BY created_at LIMIT 20`)
    for (const row of result.rows) void this.claimTask(String(row.id))
  }

  /**
   * 重排失败任务：保留原任务 ID，使已成功的提取与页面检查点可被复用，只重做失败的文档。
   * 人工重试视为运营确认，重置 attempt（MAX_ATTEMPTS 上限只约束恢复器的自动接管）。
   * 同集合已有活跃任务时拒绝。
   */
  async retryCompileTask(taskId: string): Promise<boolean> {
    const result = await pool.query(`UPDATE ${schemaName}.wiki_compile_tasks SET status='pending',error=NULL,
      completed_at=NULL,attempt=0,updated_at=NOW()
      WHERE id=$1 AND status='failed' AND attempt < $2
        AND NOT EXISTS (SELECT 1 FROM ${schemaName}.wiki_compile_tasks t2
          WHERE t2.collection_id = wiki_compile_tasks.collection_id AND t2.id <> $1 AND t2.status IN ('pending','running'))
      RETURNING collection_id`,
    [taskId, WikiCompilerService.MAX_ATTEMPTS])
    if (!result.rowCount) return false
    void this.claimTask(taskId)
    return true
  }

  private async claimTask(taskId: string): Promise<void> {
    if (this.locallyClaimed.has(taskId)) return
    this.locallyClaimed.add(taskId)
    try {
      const claimToken = `${this.workerId}:${Date.now()}:${Math.random().toString(36).slice(2)}`
      const claimed = await pool.query(`UPDATE ${schemaName}.wiki_compile_tasks SET
        status='running',worker_id=$2,lease_expires_at=NOW()+($3 * INTERVAL '1 second'),
        heartbeat_at=NOW(),attempt=attempt+1,started_at=COALESCE(started_at,NOW()),updated_at=NOW()
        WHERE id=$1 AND (status='pending' OR (status='running' AND lease_expires_at < NOW())) AND attempt < $4
        RETURNING id,collection_id,knowledge_base_id,document_id,attempt`,
      [taskId, claimToken, WikiCompilerService.LEASE_SECONDS, WikiCompilerService.MAX_ATTEMPTS])
      const task = claimed.rows[0]
      if (!task) return
      await this.runCompilation(task.id, task.collection_id, task.knowledge_base_id, task.document_id || undefined, claimToken, Number(task.attempt) || 1)
    } catch (error: any) {
      if (this.isLeaseLostError(error)) console.warn(`[WikiCompiler] durable task ${taskId} 结束：租约丢失（新 worker 已接管或任务被回收）`)
      else console.error(`[WikiCompiler] durable task ${taskId} failed:`, error)
    } finally { this.locallyClaimed.delete(taskId) }
  }

  private isLeaseLostError(error: unknown): boolean {
    return String((error as Error | undefined)?.message || '').startsWith('Compile task lease lost')
  }

  /**
   * 任务列表（运维可见性）：按集合过滤、倒序分页，含终态与错误摘要。
   */
  async listCompileTasks(collectionId: string, page: number, pageSize: number): Promise<{ items: WikiCompileTask[]; total: number }> {
    const where = eq(wikiCompileTasks.collectionId, collectionId)
    const items = await db.select().from(wikiCompileTasks)
      .where(where).orderBy(desc(wikiCompileTasks.createdAt), desc(wikiCompileTasks.id))
      .limit(pageSize).offset((page - 1) * pageSize)
    const [countRow] = await db.select({ count: sql<number>`count(*)` }).from(wikiCompileTasks).where(where)
    return { items: items.map(row => this.mapRowToTask(row)), total: countRow?.count ?? 0 }
  }

  /**
   * 取消任务：置 failed + 清空 worker，使持有租约的 worker 在下一次进度更新时因 fencing 失败而终止（不发布）。
   */
  async cancelCompileTask(taskId: string): Promise<boolean> {
    const result = await pool.query(`UPDATE ${schemaName}.wiki_compile_tasks SET status='failed',
      error='cancelled by operator', worker_id=NULL, lease_expires_at=NULL, heartbeat_at=NULL,
      completed_at=NOW(), updated_at=NOW()
      WHERE id=$1 AND status IN ('pending','running') RETURNING id`, [taskId])
    return (result.rowCount ?? 0) > 0
  }

  /**
   * 获取编译任务状态
   */
  async getCompileTask(taskId: string): Promise<WikiCompileTask | null> {
    try {
      const [result] = await db
        .select()
        .from(wikiCompileTasks)
        .where(eq(wikiCompileTasks.id, taskId))

      if (!result) {
        return null
      }

      return this.mapRowToTask(result)
    } catch (error: any) {
      throw new Error(`Failed to get compile task: ${error.message}`)
    }
  }

  /**
   * 检查是否有正在运行的编译任务（编译锁定）
   */
  async hasRunningTask(collectionId: string): Promise<boolean> {
    try {
      const result = await pool.query(`SELECT 1 FROM ${schemaName}.wiki_compile_tasks
        WHERE collection_id=$1 AND status IN ('pending','running') LIMIT 1`, [collectionId])
      return (result.rowCount ?? 0) > 0
    } catch (error: any) {
      throw new Error(`Failed to check running task: ${error.message}`)
    }
  }

  // ─── 内部编译逻辑 ─────────────────────────────────────────────────────────────

  /**
   * 后台异步编译主流程
   */
  private async runCompilation(
    taskId: string,
    collectionId: string,
    knowledgeBaseId: string,
    targetDocumentId?: string,
    claimToken = this.workerId,
    attempt = 1,
  ): Promise<void> {
    this.claimTokens.set(taskId, claimToken)
    // 用户可编辑 schema：编译按集合生效配置执行，并记录版本（可回溯"这页按什么规则生成"）。
    // 加载失败降级默认：schema 故障不应中断编译。
    let wikiSchema: WikiSchemaConfig = DEFAULT_WIKI_SCHEMA
    let schemaVersion = 0
    try {
      const { WikiSchemaService } = await import('./wiki-schema.service.js')
      const loaded = await new WikiSchemaService(new (await import('./wiki-activity-log.service.js')).WikiActivityLogService()).load(collectionId)
      wikiSchema = loaded.config
      schemaVersion = loaded.version
    } catch (schemaError) {
      console.warn('[WikiCompiler] schema 配置加载失败，使用默认：', schemaError instanceof Error ? schemaError.message : schemaError)
    }
    const progress: WikiCompileProgress = {
      schemaVersion,
      total: 0,
      processed: 0,
      skipped: 0,
      failed: 0,
      extracted: 0
    }
    let affectedConceptIds: string[] = []
    const affectedVersions = new Map<string, { updatedAt: Date; revision: number }>()
    let leaseLost = false
    const heartbeat = setInterval(() => {
      void pool.query(`UPDATE ${schemaName}.wiki_compile_tasks SET heartbeat_at=NOW(),
        lease_expires_at=NOW()+($3 * INTERVAL '1 second'),updated_at=NOW()
        WHERE id=$1 AND worker_id=$2 AND status='running'`,
      [taskId, claimToken, WikiCompilerService.LEASE_SECONDS])
        .then(result => { if (!result.rowCount) leaseLost = true })
        .catch(error => { leaseLost = true; console.error(`[WikiCompiler] heartbeat failed ${taskId}:`, error) })
    }, 15000)
    heartbeat.unref?.()
    try {
    const checkpointRows = await pool.query(`SELECT checkpoint_key,source_hash,payload
      FROM ${schemaName}.wiki_compile_checkpoints WHERE task_id=$1`, [taskId])
    const checkpoints = new Map<string, { sourceHash: string; payload: unknown }>(checkpointRows.rows.map(row =>
      [String(row.checkpoint_key), { sourceHash: String(row.source_hash), payload: row.payload }]))
    const saveCheckpoint = async (key: string, sourceHash: string, payload: unknown) => {
      await pool.query(`INSERT INTO ${schemaName}.wiki_compile_checkpoints(task_id,checkpoint_key,source_hash,payload)
        VALUES($1,$2,$3,$4) ON CONFLICT(task_id,checkpoint_key) DO UPDATE SET
        source_hash=EXCLUDED.source_hash,payload=EXCLUDED.payload,updated_at=NOW()`,
      [taskId, key, sourceHash, JSON.stringify(payload)])
      checkpoints.set(key, { sourceHash, payload })
    }

      // a. 获取知识库下所有文档（Wiki 只需要原始内容，不依赖分块/向量化状态）
      const docs = await db
        .select()
        .from(documents)
        .where(
          eq(documents.knowledgeBaseId, knowledgeBaseId)
        )

      const selectedDocs = targetDocumentId ? docs.filter(doc => doc.id === targetDocumentId) : docs
      if (targetDocumentId && selectedDocs.length === 0) throw new Error(`Document ${targetDocumentId} was deleted before compilation`)
      progress.total = selectedDocs.length
      progress.phase = 'extracting' as WikiCompilePhase
      await this.updateTaskProgress(taskId, progress)

      // 获取集合中所有已有概念名称（用于提示词去重）
      const existingConcepts = await db
        .select()
        .from(wikiConcepts)
        .where(eq(wikiConcepts.collectionId, collectionId))

      const existingConceptNames = existingConcepts.map((c) => c.conceptName)
      for (const concept of existingConcepts) affectedVersions.set(concept.id, { updatedAt: concept.updatedAt, revision: concept.revision })
      const existingSources = existingConcepts.length > 0 ? await db.select().from(wikiConceptSources)
        .where(inArray(wikiConceptSources.conceptId, existingConcepts.map(c => c.id))) : []
      const docIds = new Set(docs.map(doc => doc.id))
      const changedIds = new Set(selectedDocs.filter(doc => {
        const sources = existingSources.filter(source => source.documentId === doc.id)
        return sources.some(source => source.contentHash !== this.calculateHash(doc.content))
      }).map(doc => doc.id))
      affectedConceptIds = [...new Set(existingSources.filter(source =>
        changedIds.has(source.documentId) || (!targetDocumentId && !docIds.has(source.documentId))
      ).map(source => source.conceptId))]
      const extractions = new Map<string, ExtractedConcept[]>()

      const EXTRACT_CONCURRENCY = Math.max(1, parseInt(process.env.WIKI_EXTRACT_CONCURRENCY || '3') || 3)
      let extractSemaphore = 0
      const extractQueue: Array<() => void> = []
      const acquireExtract = () => new Promise<void>(resolve => {
        if (extractSemaphore < EXTRACT_CONCURRENCY) { extractSemaphore++; resolve() }
        else extractQueue.push(resolve)
      })
      const releaseExtract = () => {
        const next = extractQueue.shift()
        if (next) next()
        else extractSemaphore--
      }

      await Promise.all(selectedDocs.map(async (doc) => {
        await acquireExtract()
        try {
          const contentHash = this.calculateHash(doc.content)

          let markdownContent = doc.content
          if (doc.type === 'tiptap') {
            try {
              const tiptapJson = JSON.parse(doc.content)
              try {
                markdownContent = await tiptapToMarkdownLLM(tiptapJson)
              } catch {
                markdownContent = tiptapToMarkdown(tiptapJson)
              }
            } catch {
            }
          }

          const docSources = existingSources.filter(source => source.documentId === doc.id)
          if (docSources.length > 0 && docSources.every(source => source.contentHash === contentHash
            && ['compiled', 'needs_review'].includes(existingConcepts.find(concept => concept.id === source.conceptId)?.status || '')
            && existingConcepts.find(concept => concept.id === source.conceptId)?.citationStatus === 'verified')) {
            progress.skipped++
            progress.processed++
            await this.updateTaskProgress(taskId, progress)
            return
          }

          const extractionHash = this.calculateHash(doc.content)
          const cachedExtraction = checkpoints.get(`extract:${doc.id}`)
          const extractedConcepts = cachedExtraction?.sourceHash === extractionHash
            ? cachedExtraction.payload as ExtractedConcept[]
            : await this.extractConceptsWithRetry(markdownContent, [...existingConceptNames], doc.id,
              { sourceCharLimit: wikiSchema.sourceCharLimit, maxConcepts: wikiSchema.maxConceptsPerDoc, tagWhitelist: wikiSchema.tagWhitelist })

          if (extractedConcepts === null) {
            const failure = this.getExtractionFailure(doc.id)
            progress.failed++
            progress.processed++
            progress.warnings = [...(progress.warnings || []), `extract ${doc.id}: ${failure?.reason ?? 'unknown'}`]
            await this.updateTaskProgress(taskId, progress)
            return
          }
          if (cachedExtraction?.sourceHash !== extractionHash) {
            await saveCheckpoint(`extract:${doc.id}`, extractionHash, extractedConcepts)
          }

          extractions.set(doc.id, extractedConcepts)

          progress.extracted += extractedConcepts.length
          progress.processed++
          await this.updateTaskProgress(taskId, progress)
        } catch (docError: any) {
          if (isRateLimitError(docError)) {
            // 限流是配额问题不是文档问题：立即中断整批，避免剩余文档继续消耗配额。
            throw docError
          }
          console.error(`[WikiCompiler] 处理文档 ${doc.id} 时出错:`, docError)
          progress.failed++
          progress.processed++
          await this.updateTaskProgress(taskId, progress)
        } finally {
          releaseExtract()
        }
      }))

      if (progress.failed > 0) throw new Error(`Wiki extraction failed for ${progress.failed} document(s); no pages published`)
      const plan = buildCompilationPlan(docs, existingConcepts, existingSources, extractions, !targetDocumentId)
      affectedConceptIds = plan.flatMap(target => target.previous ? [target.previous.id] : [])

      const allConceptsInCollection = await db
        .select({ id: wikiConcepts.id, conceptName: wikiConcepts.conceptName })
        .from(wikiConcepts)
        .where(and(eq(wikiConcepts.collectionId, collectionId), eq(wikiConcepts.status, 'compiled')))

      const allConceptNames = allConceptsInCollection.map((c) => c.conceptName)

      progress.phase = 'extracting_relations' as WikiCompilePhase
      await this.updateTaskProgress(taskId, progress)

      const newConceptNames = plan.filter(target => target.sources.length > 0).map(target => target.conceptName)
      const retiredNames = new Set(plan.filter(target => target.sources.length === 0).map(target => target.conceptName))
      const candidateNames = [...new Set([...allConceptNames, ...newConceptNames])].filter(name => !retiredNames.has(name) && name !== '_index')
      if (newConceptNames.length > 0 && candidateNames.length > 1) {
        const docContents = selectedDocs.map(doc => doc.content).join('\n\n---\n\n').slice(0, 8000)

        const relations = await this.extractRelationsWithLLM(newConceptNames, candidateNames, docContents)
        for (const rel of relations) {
          const target = plan.find(target => target.conceptName === rel.source)
          if (!target) continue
          const existing = target.relatedConcepts
          if (!existing.some(e => e.name === rel.target)) {
            existing.push({ name: rel.target, type: rel.type })
          }
        }
      }

      progress.phase = 'generating_pages' as WikiCompilePhase
      progress.pagesToGenerate = plan.filter(target => target.sources.length > 0).length
      progress.pagesGenerated = 0
      progress.pagesAttempted = 0
      progress.pagesFailed = 0
      progress.pagesPublished = 0
      await this.updateTaskProgress(taskId, progress)

      const PAGE_GEN_CONCURRENCY = resolveConcurrency(
        Math.max(1, parseInt(process.env.WIKI_PAGE_GEN_CONCURRENCY || String(WikiCompilerService.DEFAULT_PAGE_CONCURRENCY)) || WikiCompilerService.DEFAULT_PAGE_CONCURRENCY),
        attempt)
      const drafts = new Map<string, NonNullable<Awaited<ReturnType<WikiCompilerService['generatePageDraft']>>>>()
      const sourceManifests = new Map<string, WikiSourceManifest[]>()
      // 限流中止标志：任一页面确认限流后，其余 worker 不再领取新页面。
      let rateLimitAbort = false

      const runWithConcurrency = async <T>(
        items: T[],
        fn: (item: T) => Promise<void>,
        concurrency: number,
      ) => {
        let idx = 0
        const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
          while (idx < items.length && !rateLimitAbort) {
            const item = items[idx++]
            await fn(item)
          }
        })
        const results = await Promise.allSettled(workers)
        const failed = results.find(result => result.status === 'rejected')
        if (failed?.status === 'rejected') throw failed.reason
      }

      await runWithConcurrency(
        plan.filter(target => target.sources.length > 0),
        async (target) => {
          progress.pagesAttempted = (progress.pagesAttempted ?? 0) + 1
          try {
            const manifests = target.sources.map(source => buildSourceManifest(source.document))
            sourceManifests.set(target.slug, manifests)
            const validRelated = target.relatedConcepts.filter(relation => candidateNames.includes(relation.name))
            const sourceHash = this.calculateHash(manifests.map(manifest => manifest.contentHash).join(':'))
            const checkpointKey = `page:${target.slug}`
            const cachedDraft = checkpoints.get(checkpointKey)
            const draft = cachedDraft?.sourceHash === sourceHash
              ? cachedDraft.payload as NonNullable<Awaited<ReturnType<WikiCompilerService['generatePageDraft']>>>
              : await this.generatePageDraft(target.conceptName, manifests,
                validRelated.map(relation => relation.name), target.previous?.content,
                { sourceCharLimit: wikiSchema.sourceCharLimit, outputLanguage: wikiSchema.outputLanguage,
                  pageStyle: wikiSchema.pageStyle, tagWhitelist: wikiSchema.tagWhitelist,
                  pageStructure: wikiSchema.pageStructure })
            if (!draft) {
              const failure = this.getPageFailure(target.conceptName)
              throw new Error(`Invalid Wiki page draft: ${target.slug} (${failure?.reason ?? 'unknown'}${failure?.finishReason ? `, finish=${failure.finishReason}` : ''})`)
            }
            const provenanceErrors = validatePageProvenance(draft, manifests)
            if (provenanceErrors.length) throw new WikiProvenanceError(provenanceErrors)
            if (cachedDraft?.sourceHash !== sourceHash) await saveCheckpoint(checkpointKey, sourceHash, draft)
            if (wikiSchema.tagWhitelist?.length && draft.tags) {
              draft.tags = draft.tags.filter(tag => target.aliasTags.includes(tag) || wikiSchema.tagWhitelist!.includes(tag))
            }
            drafts.set(target.slug, draft)
            progress.pagesGenerated = (progress.pagesGenerated ?? 0) + 1
          } catch (error) {
            if (isRateLimitError(error)) {
              // 限流不计为页面内容失败：中断批次，保留已成功页面的检查点，等待配额恢复后原地重试。
              rateLimitAbort = true
              throw error
            }
            progress.pagesFailed = (progress.pagesFailed ?? 0) + 1
            progress.warnings = [...(progress.warnings || []), `${target.slug}: ${String(error).slice(0, 1000)}`]
            console.warn(`[WikiCompiler] 概念 ${target.conceptName} 草稿失败:`, error)
          }
          await this.updateTaskProgress(taskId, progress)
        },
        PAGE_GEN_CONCURRENCY,
      )
      if ((progress.pagesFailed ?? 0) > 0 && !allowPartialPublish(progress.pagesAttempted ?? 0, progress.pagesFailed ?? 0)) {
        throw new Error(`Wiki page generation failed for ${progress.pagesFailed} page(s); no pages published`)
      }
      if ((progress.pagesFailed ?? 0) > 0) {
        progress.warnings = [...(progress.warnings || []), `partial publish: ${progress.pagesFailed} failed page(s) skipped and marked failed`]
      }

      progress.phase = 'building_relations' as WikiCompilePhase
      await this.updateTaskProgress(taskId, progress)
      if (leaseLost) throw new Error('Compile task lease lost; refusing to publish')
      const publishedConceptIds = plan.length > 0
        ? await this.publishCompilation(collectionId, knowledgeBaseId, docs, plan, drafts, sourceManifests, taskId, claimToken, wikiSchema)
        : []
      progress.pagesPublished = drafts.size

      // 6a. 生成 _index 概念页
      try {
        progress.phase = 'generating_index' as WikiCompilePhase
        await this.updateTaskProgress(taskId, progress)
        await this.generateIndexPage(collectionId, taskId)
      } catch (indexError: any) {
        console.warn(`[WikiCompiler] Index 页面生成失败:`, indexError?.message)
        progress.warnings = [...(progress.warnings || []), `Index generation failed: ${indexError?.message}`]
        await db.update(wikiConcepts).set({ status: 'outdated', updatedAt: new Date() })
          .where(and(eq(wikiConcepts.collectionId, collectionId), eq(wikiConcepts.slug, '_index')))
      }

      try {
        progress.phase = 'linting' as WikiCompilePhase
        await this.updateTaskProgress(taskId, progress)
        const { WikiLintService } = await import('./wiki-lint.service.js')
        const lintService = new WikiLintService()
        // schema 开启自动语义 lint 时一并审查（增量：只审本轮发布页）；失败记 warning 不阻断编译。
        const lintResults = wikiSchema.autoSemanticLint === true && publishedConceptIds.length > 0
          ? await lintService.runLint(collectionId, true, { conceptIds: publishedConceptIds })
          : await lintService.runStructuralLint(collectionId)
        progress.lintResults = lintResults
        if (wikiSchema.autoSemanticLint === true && lintResults.some(result => !['orphan', 'broken_link', 'no_outlinks'].includes(result.type))) {
          progress.warnings = [...(progress.warnings || []), `semantic lint: ${lintResults.filter(r => !['orphan', 'broken_link', 'no_outlinks'].includes(r.type)).length} issue(s) found (reviewed ${publishedConceptIds.length} page(s))`]
        }
      } catch (lintError: any) {
        console.warn(`[WikiCompiler] Lint 执行失败:`, lintError?.message)
        progress.warnings = [...(progress.warnings || []), `Lint failed: ${lintError?.message}`]
      }
      progress.phase = 'done' as WikiCompilePhase
      // 集合信息先落库，再公布任务终态，避免客户端看到 completed 后读到旧计数。
      const allConcepts = await db.select({ id: wikiConcepts.id }).from(wikiConcepts)
        .where(and(eq(wikiConcepts.collectionId, collectionId), eq(wikiConcepts.status, 'compiled')))
      await this.wikiCollectionService.updateCollection(collectionId, {
        lastCompiledAt: new Date(), conceptCount: allConcepts.length,
      })
      const completed = await db
        .update(wikiCompileTasks)
        .set({
          status: 'completed' as WikiCompileTaskStatus,
          progress,
          completedAt: new Date(),
          leaseExpiresAt: null,
          heartbeatAt: null,
          updatedAt: new Date()
        })
        .where(and(eq(wikiCompileTasks.id, taskId), eq(wikiCompileTasks.workerId, claimToken)))
        .returning({ id: wikiCompileTasks.id })
      if (!completed.length) throw new Error('Compile task lease lost before completion')
      clearInterval(heartbeat)
      this.claimTokens.delete(taskId)
      await pool.query(`DELETE FROM ${schemaName}.wiki_compile_checkpoints WHERE task_id=$1`, [taskId])
      // 追加式操作日志：编译结果可审计（含部分发布的跳过数）。
      try {
        const { WikiActivityLogService } = await import('./wiki-activity-log.service.js')
        await new WikiActivityLogService().append(collectionId, 'compile', {
          taskId, mode: targetDocumentId ? 'document' : 'full', schemaVersion,
          published: progress.pagesPublished ?? 0, generated: progress.pagesGenerated ?? 0,
          failedPages: progress.pagesFailed ?? 0, failedDocs: progress.failed ?? 0,
          partial: (progress.pagesFailed ?? 0) > 0, warnings: progress.warnings?.length ?? 0,
        })
      } catch (logError) {
        console.warn('[WikiCompiler] 活动日志写入失败（不影响编译结果）:', logError instanceof Error ? logError.message : logError)
      }

    } catch (rawError: any) {
      // 限流属于外部配额问题：统一改写为明确的任务级错误，避免与内容失败混淆。
      const error = isRateLimitError(rawError)
        ? new Error('Wiki compile aborted by provider rate limit; wait for quota recovery, then retry the task (checkpoints preserved, concurrency auto-halves per attempt)')
        : rawError
      // 7. 编译失败 → 更新任务状态，记录错误；租约丢失是 fencing 预期行为，与真实失败分级记录。
      if (this.isLeaseLostError(error)) console.warn(`[WikiCompiler] 任务 ${taskId} 租约丢失，本执行终止（新 worker 已接管或任务被回收）`)
      else console.error(`[WikiCompiler] 任务 ${taskId} 编译失败:`, error)

      if (affectedConceptIds.length > 0) {
        for (const id of affectedConceptIds) {
          const version = affectedVersions.get(id)
          if (version) await db.update(wikiConcepts).set({ status: 'outdated', updatedAt: new Date() })
            .where(and(eq(wikiConcepts.collectionId, collectionId), eq(wikiConcepts.id, id),
              eq(wikiConcepts.updatedAt, version.updatedAt), eq(wikiConcepts.revision, version.revision)))
        }
      }

      await db
        .update(wikiCompileTasks)
        .set({
          status: 'failed' as WikiCompileTaskStatus,
          progress,
          error: error.message,
          completedAt: new Date(),
          updatedAt: new Date()
        })
        .where(and(eq(wikiCompileTasks.id, taskId), eq(wikiCompileTasks.workerId, claimToken)))

      clearInterval(heartbeat)
      this.claimTokens.delete(taskId)
      // 保留失败任务检查点；重试时仅复用来源哈希匹配的成功步骤。

      throw error
    }
  }

  /**
   * 调用 LLM 提取概念，失败时重试一次
   * 返回提取到的概念数组，两次都失败则返回 null
   */
  async extractConceptsWithRetry(
    content: string,
    existingConcepts: string[],
    documentId: string,
    options?: { sourceCharLimit?: number; maxConcepts?: number; tagWhitelist?: string[] }
  ): Promise<ExtractedConcept[] | null> {
    const charLimit = options?.sourceCharLimit ?? WikiCompilerService.MAX_SOURCE_CHARS
    const truncated = content.length > charLimit
      ? content.slice(0, charLimit) + '\n\n[文档内容已截断]'
      : content
    const prompt = buildExtractionPrompt(truncated, existingConcepts, undefined,
      { maxConcepts: options?.maxConcepts, tagWhitelist: options?.tagWhitelist })

    // 第一次尝试
    let first: Awaited<ReturnType<typeof generateText>>
    try {
      first = await generateText({
        model: openaiChat(getDefaultChatModel()),
        system: prompt,
        messages: [{ role: 'user', content: '请提取文档中的关键概念。' }],
        maxOutputTokens: WikiCompilerService.EXTRACTION_MAX_TOKENS,
        abortSignal: AbortSignal.timeout(WikiCompilerService.LLM_TIMEOUT_MS)
      })
    } catch (error: any) {
      if (isRateLimitError(error)) {
        // 限流必须穿透本层 catch 中断批次，不能被吞成 null 计入页面失败。
        this.recordExtractionFailure(documentId, 1, 'llm_error', 0)
        throw error
      }
      console.error(`[WikiCompiler] LLM 调用失败（文档 ${documentId}）:`, error)
      this.recordExtractionFailure(documentId, 1, 'llm_error', 0)
      return null
    }

    const concepts = parseAndValidateExtraction(first.text)

    // 第一次成功
    if (concepts !== null) {
      this.extractionFailures.delete(documentId)
      return capConcepts(concepts, options?.maxConcepts)
    }

    this.recordExtractionFailure(documentId, 1, this.classifyExtractionOutput(first), first.text.length, first)

    // 仅格式失败重试；合法的零概念结果不重试。
    console.warn(
      `[WikiCompiler] 文档 ${documentId} 第一次提取格式无效，触发重试...`
    )

    const retryPrompt =
      prompt +
      '\n\n【重要提示】上次输出格式不正确或未提取到概念。请确保以有效 JSON 格式返回结果，格式示例：' +
      '{"concepts": [{"concept": "概念名", "summary": "一句话描述", "is_new": true, "tags": [], "related_concepts": []}]}'

    try {
      const retry = await generateText({
        model: openaiChat(getDefaultChatModel()),
        system: retryPrompt,
        messages: [
          {
            role: 'user',
            content: '请重新提取文档中的关键概念，确保返回正确的 JSON 格式。'
          }
        ],
        maxOutputTokens: WikiCompilerService.EXTRACTION_MAX_TOKENS,
        abortSignal: AbortSignal.timeout(WikiCompilerService.LLM_TIMEOUT_MS)
      })

      const retried = parseAndValidateExtraction(retry.text)
      if (retried !== null) {
        this.extractionFailures.delete(documentId)
        return capConcepts(retried, options?.maxConcepts)
      }
      this.recordExtractionFailure(documentId, 2, this.classifyExtractionOutput(retry), retry.text.length, retry)
      return null
    } catch (error: any) {
      if (isRateLimitError(error)) {
        this.recordExtractionFailure(documentId, 2, 'llm_error', 0)
        throw error
      }
      console.error(`[WikiCompiler] LLM 重试失败（文档 ${documentId}）:`, error)
      this.recordExtractionFailure(documentId, 2, 'llm_error', 0)
      return null
    }
  }

  getExtractionFailure(documentId: string): ExtractionFailure | undefined {
    return this.extractionFailures.get(documentId)
  }

  getPageFailure(conceptName: string): PageDraftFailure | undefined {
    return this.pageFailures.get(conceptName)
  }

  private recordPageFailure(
    conceptName: string,
    text: string,
    finishReason: string | undefined,
    usage: { outputTokens?: number; reasoningTokens?: number } | undefined,
  ): void {
    const reason: PageDraftFailure['reason'] =
      finishReason === 'length' ? 'truncated' : text.includes('{') ? 'invalid_output' : 'no_json'
    const failure: PageDraftFailure = {
      reason,
      finishReason,
      outputTokens: usage?.outputTokens,
      reasoningTokens: usage?.reasoningTokens,
      textLength: text.length,
    }
    this.pageFailures.set(conceptName, failure)
    console.warn(`[WikiCompiler] 概念 ${conceptName} 页面草稿无效: ${reason}`, {
      finishReason, outputTokens: usage?.outputTokens, reasoningTokens: usage?.reasoningTokens, textLength: text.length,
    })
  }

  private classifyExtractionOutput(result: { text: string; finishReason?: string }): ExtractionFailureReason {
    if (result.finishReason === 'length') return 'truncated'
    if (!result.text.includes('{')) return 'no_json'
    return 'invalid_output'
  }

  private recordExtractionFailure(
    documentId: string,
    attempt: number,
    reason: ExtractionFailureReason,
    textLength: number,
    result?: { finishReason?: string; usage?: { outputTokens?: number; reasoningTokens?: number } },
  ): void {
    const failure: ExtractionFailure = {
      reason,
      attempt,
      finishReason: result?.finishReason,
      outputTokens: result?.usage?.outputTokens,
      reasoningTokens: result?.usage?.reasoningTokens,
      textLength,
    }
    this.extractionFailures.set(documentId, failure)
    // 只记录元数据，不记录模型正文，避免日志泄露文档内容。
    console.warn(`[WikiCompiler] 文档 ${documentId} 提取失败（第 ${attempt} 次）: ${reason}`, {
      finishReason: failure.finishReason,
      outputTokens: failure.outputTokens,
      reasoningTokens: failure.reasoningTokens,
      textLength: failure.textLength,
    })
  }

  // ─── 内部辅助方法 ─────────────────────────────────────────────────────────────

  private async generatePageDraft(
    conceptName: string,
    manifests: WikiSourceManifest[],
    relatedConceptNames?: string[],
    existingPage?: unknown,
    options?: { sourceCharLimit?: number; outputLanguage?: 'zh' | 'en'; pageStyle?: 'neutral' | 'concise' | 'formal'; tagWhitelist?: string[]; pageStructure?: { definition: boolean; summary: boolean } },
  ) {
    // 瘦身协议：给模型的清单只含全局块序号与原文；证据由模型指认、服务器回填。
    const sourceContent = formatSourceManifestsForModel(manifests)
    const charLimit = options?.sourceCharLimit ?? WikiCompilerService.MAX_SOURCE_CHARS
    if (sourceContent.length > charLimit) {
      console.warn(`[WikiCompiler] 概念 ${conceptName} 全量来源超过限制，拒绝截断发布`)
      return null
    }
    const prompt = buildPagePrompt(conceptName, sourceContent,
      existingPage ? JSON.stringify(existingPage) : undefined, relatedConceptNames,
      { outputLanguage: options?.outputLanguage, pageStyle: options?.pageStyle, tagWhitelist: options?.tagWhitelist,
        pageStructure: options?.pageStructure })

    try {
      const result = await generateText({
        model: openaiChat(getDefaultChatModel()),
        system: prompt,
        messages: [{ role: 'user', content: '请为这个概念生成 Wiki 页面。' }],
        maxOutputTokens: WikiCompilerService.PAGE_GEN_MAX_TOKENS,
        abortSignal: AbortSignal.timeout(WikiCompilerService.LLM_TIMEOUT_MS)
      })
      const { text, finishReason, usage } = result as { text: string; finishReason?: string; usage?: { outputTokens?: number; reasoningTokens?: number } }

      const rawPage = parseRawPageContent(text)
      if (!rawPage || !rawPage.sections?.some((section: any) => String(section.content || '').trim())) {
        // 解析或结构失败必须可观测：记录 finishReason 与用量，便于区分截断与格式问题。
        this.recordPageFailure(conceptName, text, finishReason, usage)
        return null
      }
      this.pageFailures.delete(conceptName)
      // 回填 blockIndex+anchor 证据为完整 { refId, quote }；锚点不实即拒绝。
      const { page: pageContent, errors: materializeErrors } = materializePageContent(rawPage, manifests)
      // 结构选项：关闭的字段剔除（模型输出也被丢弃），发布层据此不兜底。
      if (options?.pageStructure && !options.pageStructure.definition) { delete pageContent.definition; delete pageContent.definitionEvidence }
      if (options?.pageStructure && !options.pageStructure.summary) { delete pageContent.summary; delete pageContent.summaryEvidence }
      const errors = [...materializeErrors, ...validatePageProvenance(pageContent, manifests)]
      if (errors.length > 0) throw new WikiProvenanceError(errors)

      if (relatedConceptNames && relatedConceptNames.length > 0) {
        const slugMap = new Map<string, string>(
          relatedConceptNames.map((name) => [name, conceptToSlug(name)])
        )
        pageContent.sections = pageContent.sections.map((section) => ({
          ...section,
          content: this.resolveWikiLinks(section.content, slugMap),
          claims: (section.claims ?? []).map(claim => ({ ...claim, statement: this.resolveWikiLinks(claim.statement, slugMap) })),
        }))
      }

      return pageContent
    } catch (error) {
      console.error(`[WikiCompiler] 概念 ${conceptName} 页面生成失败:`, error)
      if (error instanceof WikiProvenanceError) throw error
      if (isRateLimitError(error)) throw error
      return null
    }
  }

  private async publishCompilation(
    collectionId: string,
    knowledgeBaseId: string,
    snapshotDocs: CompilationDocument[],
    plan: CompilationTarget[],
    drafts: Map<string, NonNullable<Awaited<ReturnType<WikiCompilerService['generatePageDraft']>>>>,
    manifests: Map<string, WikiSourceManifest[]>,
    taskId: string,
    claimToken: string,
    wikiSchema: WikiSchemaConfig = DEFAULT_WIKI_SCHEMA,
  ): Promise<string[]> {
    return await db.transaction(async tx => {
      const [task] = await tx.select().from(wikiCompileTasks).where(eq(wikiCompileTasks.id, taskId)).for('update')
      if (!task || task.status !== 'running' || task.workerId !== claimToken
        || !task.leaseExpiresAt || task.leaseExpiresAt.getTime() <= Date.now()) {
        throw new Error('Compile task lease lost; refusing to publish')
      }
      // 短事务锁定发布，不在事务中等待模型；旧 worker 不能覆盖新页面。
      const [collection] = await tx.select().from(wikiCollections)
        .where(eq(wikiCollections.id, collectionId)).for('update')
      if (!collection) throw new Error('Wiki collection was deleted during compilation')
      const currentDocs = await tx.select().from(documents)
        .where(eq(documents.knowledgeBaseId, knowledgeBaseId)).for('share')
      const currentHashes = new Map(currentDocs.map(doc => [doc.id, this.calculateHash(doc.content)]))
      if (snapshotDocs.length !== currentDocs.length || snapshotDocs.some(doc => currentHashes.get(doc.id) !== this.calculateHash(doc.content))) {
        throw new Error('Wiki sources changed during compilation; retry required')
      }
      const currentConcepts = await tx.select().from(wikiConcepts)
        .where(eq(wikiConcepts.collectionId, collectionId)).for('update')
      for (const target of plan) {
        const current = currentConcepts.find(concept => concept.slug === target.slug)
        if (target.previous ? !current || current.revision !== (target.previous.revision ?? 0) : !!current) {
          throw new Error('Wiki page changed during compilation; retry required')
        }
      }
      await tx.update(wikiConcepts).set({ status: 'outdated', updatedAt: new Date() })
        .where(and(eq(wikiConcepts.collectionId, collectionId), eq(wikiConcepts.slug, '_index')))
      const relationPlans: Array<{ id: string; conceptName: string; sourceRevision: number;
        relatedConcepts: Array<{ name: string; type: string; origin: string; evidence: WikiEvidence[] }> }> = []
      const revisionRecords: Array<typeof wikiPageRevisions.$inferInsert> = []
      for (const target of plan) {
        const id = target.previous?.id ?? this.generateConceptId()
        const now = new Date()
        const revision = (target.previous?.revision ?? 0) + 1
        if (target.sources.length === 0) {
          // 保留旧正文供审计，但从默认检索中排除，并清除所有失效关系。
          await tx.update(wikiConcepts).set({ status: 'no_concepts', occurrenceCount: 0, revision, updatedAt: now })
            .where(and(eq(wikiConcepts.collectionId, collectionId), eq(wikiConcepts.id, id)))
          await tx.delete(wikiRelationships).where(and(eq(wikiRelationships.collectionId, collectionId),
            or(eq(wikiRelationships.sourceConceptId, id), eq(wikiRelationships.targetConceptId, id))))
        } else {
          const draft = drafts.get(target.slug)
          if (!draft) {
            // 部分发布：顽固失败页不阻塞整批；对应概念标记 failed（保留旧正文供审计），不产新修订。
            if (target.previous) {
              await tx.update(wikiConcepts).set({ status: 'failed', updatedAt: now })
                .where(and(eq(wikiConcepts.collectionId, collectionId), eq(wikiConcepts.id, id)))
              await tx.delete(wikiRelationships).where(and(eq(wikiRelationships.collectionId, collectionId),
                eq(wikiRelationships.sourceConceptId, id)))
            }
            continue
          }
          const text = draft.sections.map(section => section.content).join('\n\n')
          const values = { definition: wikiSchema.pageStructure.definition ? (draft.definition || draft.sections[0].content.slice(0, 1500)) : null,
            summary: wikiSchema.pageStructure.summary ? (draft.summary || text.slice(0, 500)) : null, tags: [...new Set([...(draft.tags || []), ...target.aliasTags])],
            content: draft, occurrenceCount: target.sources.length,
            status: (draft.conflicts ?? []).length > 0 ? 'needs_review' as const : 'compiled' as const,
            revision, citationStatus: 'verified', updatedAt: now }
          if (target.previous) await tx.update(wikiConcepts).set(values)
            .where(and(eq(wikiConcepts.collectionId, collectionId), eq(wikiConcepts.id, id)))
          else await tx.insert(wikiConcepts).values({ id, collectionId, conceptName: target.conceptName,
            slug: target.slug, createdAt: now, ...values })
          await tx.delete(wikiRelationships).where(and(eq(wikiRelationships.collectionId, collectionId), eq(wikiRelationships.sourceConceptId, id)))
          const links = draft.sections.flatMap(section => [...section.content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)].map(match => match[1]))
          const names = [...(draft.relatedConcepts || []).map(name => name.replace(/^\[\[|\]\]$/g, '')), ...links]
          relationPlans.push({ id, conceptName: target.conceptName, sourceRevision: revision,
            relatedConcepts: [
              ...target.relatedConcepts.map(relation => ({ ...relation, origin: 'model-inferred', evidence: [] })),
              ...names.map(name => {
                const sections = draft.sections.filter(section => section.content.includes(`[[${name}]]`))
                return { name, type: 'related', origin: sections.length ? 'page-link' : 'model-inferred',
                  evidence: sections.flatMap(section => (section.claims ?? []).flatMap(claim => claim.evidence)) }
              }),
            ] })
        }
        await tx.delete(wikiConceptSources).where(eq(wikiConceptSources.conceptId, id))
        if (target.sources.length > 0) await tx.insert(wikiConceptSources).values(target.sources.map(source => ({
          id: this.generateSourceId(), conceptId: id, documentId: source.document.id,
          contentHash: source.contentHash, compiledAt: now,
        })))
        const [published] = await tx.select().from(wikiConcepts).where(eq(wikiConcepts.id, id))
        revisionRecords.push({ id: `wiki_revision_${id}_${revision}`,
          conceptId: id, collectionId, revision, taskId,
          reason: target.sources.length === 0 ? 'withdrawn' : 'compiled',
          pageSnapshot: published, sourceSnapshot: manifests.get(target.slug) || [], createdAt: now })
      }
      await this.buildRelationships(collectionId, relationPlans, tx)
      for (const record of revisionRecords) {
        const relationships = await tx.select().from(wikiRelationships).where(and(
          eq(wikiRelationships.collectionId, collectionId), eq(wikiRelationships.sourceConceptId, record.conceptId)))
        await tx.insert(wikiPageRevisions).values({ ...record, relationshipSnapshot: relationships })
      }
      return revisionRecords.map(record => record.conceptId)
    })
  }

  private resolveWikiLinks(content: string, knownSlugs: Map<string, string>): string {
    let resolved = content
    for (const [conceptName, slug] of knownSlugs) {
      const escapedName = conceptName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const nameRegex = new RegExp(`\\[\\[${escapedName}\\]\\]`, 'g')
      resolved = resolved.replace(nameRegex, `[[${slug}]]`)

      if (slug !== conceptName) {
        const escapedSlug = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const slugRegex = new RegExp(`\\[\\[${escapedSlug}\\]\\]`, 'g')
        resolved = resolved.replace(slugRegex, `[[${slug}]]`)
      }
    }
    return resolved
  }

  async buildRelationships(
    collectionId: string,
    concepts: Array<{ id: string; conceptName: string; sourceRevision?: number;
      relatedConcepts: Array<{name: string; type: string; origin?: string; evidence?: WikiEvidence[]}> }>,
    queryRunner: QueryRunner = db
  ): Promise<void> {
    const allConceptsInCollection = await queryRunner
      .select({ id: wikiConcepts.id, conceptName: wikiConcepts.conceptName, slug: wikiConcepts.slug })
      .from(wikiConcepts)
      .where(and(eq(wikiConcepts.collectionId, collectionId), eq(wikiConcepts.status, 'compiled')))

    const conceptNameToId = new Map(allConceptsInCollection.map((c) => [c.conceptName, c.id]))
    const conceptSlugToId = new Map(allConceptsInCollection.map((c) => [c.slug, c.id]))

    for (const concept of concepts) {
      for (const rel of concept.relatedConcepts) {
        const targetId = conceptNameToId.get(rel.name) ?? conceptSlugToId.get(rel.name)
        if (!targetId || targetId === concept.id) continue

        const relType = rel.type || 'related'

        const existing = await queryRunner
          .select()
          .from(wikiRelationships)
          .where(
            and(
              eq(wikiRelationships.sourceConceptId, concept.id),
              eq(wikiRelationships.targetConceptId, targetId),
              eq(wikiRelationships.relationshipType, relType)
            )
          )
          .limit(1)

        if (existing.length === 0) {
          await queryRunner.insert(wikiRelationships).values({
            id: `wiki_rel_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
            collectionId,
            sourceConceptId: concept.id,
            targetConceptId: targetId,
            relationshipType: relType,
            sourceRevision: concept.sourceRevision,
            origin: rel.origin || 'legacy',
            evidence: rel.evidence || [],
            strength: 1,
            createdAt: new Date()
          })
        }
      }
    }
  }

  private async updateTaskProgress(
    taskId: string,
    progress: WikiCompileProgress
  ): Promise<void> {
    const claimToken = this.claimTokens.get(taskId) ?? this.workerId
    const result = await db
      .update(wikiCompileTasks)
      .set({
        progress,
        updatedAt: new Date()
      })
      .where(and(eq(wikiCompileTasks.id, taskId), eq(wikiCompileTasks.workerId, claimToken),
        eq(wikiCompileTasks.status, 'running')))
      .returning({ id: wikiCompileTasks.id })
    if (result.length === 0) throw new Error('Compile task lease lost while updating progress')
  }

  private mapRowToTask(row: Record<string, unknown>): WikiCompileTask {
    return {
      id: row.id as string,
      collectionId: row.collectionId as string,
      knowledgeBaseId: row.knowledgeBaseId as string,
      status: row.status as WikiCompileTaskStatus,
      progress: row.progress as WikiCompileProgress,
      error: (row.error as string) || undefined,
      documentId: (row.documentId as string | null) ?? undefined,
      attempt: (row.attempt as number | null) ?? undefined,
      startedAt: (row.startedAt as Date) || undefined,
      completedAt: (row.completedAt as Date) || undefined,
      createdAt: row.createdAt as Date,
      updatedAt: row.updatedAt as Date
    }
  }

  private async generateIndexPage(collectionId: string, taskId: string): Promise<void> {
    // 索引是已发布页的确定性投影，不能再通过不带原文证据的模型生成新事实。
    await db.transaction(async tx => {
      const [collection] = await tx.select().from(wikiCollections).where(eq(wikiCollections.id, collectionId)).for('update')
      if (!collection) throw new Error('Wiki collection deleted before index publication')
      const concepts = await tx.select().from(wikiConcepts).where(and(
        eq(wikiConcepts.collectionId, collectionId), eq(wikiConcepts.status, 'compiled'),
        eq(wikiConcepts.citationStatus, 'verified'), sql`${wikiConcepts.slug} != '_index'`)).for('share')
      concepts.sort((a, b) => a.slug.localeCompare(b.slug))
      const [previous] = await tx.select().from(wikiConcepts).where(and(
        eq(wikiConcepts.collectionId, collectionId), eq(wikiConcepts.slug, '_index'))).for('update')
      if (concepts.length === 0 && !previous) return
      const sourceSnapshot = concepts.map(concept => ({ conceptId: concept.id, revision: concept.revision, summary: concept.summary }))
      const content = { sections: concepts.length > 0 ? [{ heading: '已验证引用的概念导航',
        content: concepts.map(concept => `- [[${concept.slug}]]：${concept.summary || ''}`).join('\n'),
        sourceRefs: concepts.map(concept => `concept:${concept.id}:revision:${concept.revision}`) }] : [], relatedConcepts: [] }
      const status = concepts.length > 0 ? 'compiled' as const : 'no_concepts' as const
      const previousContent = previous?.content as { sections?: Array<{ heading: string; content: string; sourceRefs?: string[] }> } | null
      const previousSections = (previousContent?.sections || []).map(section => ({ heading: section.heading, content: section.content, sourceRefs: section.sourceRefs || [] }))
      if (previous?.citationStatus === 'derived' && previous.status === status && JSON.stringify(previousSections) === JSON.stringify(content.sections)) return
      const id = previous?.id ?? this.generateConceptId()
      const revision = (previous?.revision ?? 0) + 1
      const now = new Date()
      const values = { content, summary: 'Wiki Index - 概念总览与导航', status, citationStatus: 'derived', revision, updatedAt: now }
      if (previous) await tx.update(wikiConcepts).set(values).where(eq(wikiConcepts.id, id))
      else await tx.insert(wikiConcepts).values({ id, collectionId, conceptName: '_index', slug: '_index',
        tags: ['system', 'index'], occurrenceCount: 0, createdAt: now, ...values })
      const [published] = await tx.select().from(wikiConcepts).where(eq(wikiConcepts.id, id))
      await tx.insert(wikiPageRevisions).values({ id: `wiki_revision_${id}_${revision}`, conceptId: id,
        collectionId, revision, taskId, reason: 'index-derived', pageSnapshot: published, sourceSnapshot, createdAt: now })
    })
  }

  private async buildBacklinksFromContent(collectionId: string): Promise<void> {
    const allConcepts = await db
      .select({ id: wikiConcepts.id, slug: wikiConcepts.slug, content: wikiConcepts.content })
      .from(wikiConcepts)
      .where(eq(wikiConcepts.collectionId, collectionId))

    const slugToId = new Map(allConcepts.map(c => [c.slug, c.id]))
    const wikilinkRegex = /\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g

    for (const concept of allConcepts) {
      if (!concept.content) continue
      const sections = (concept.content as any).sections ?? []
      const fullText = sections.map((s: any) => s.content || '').join(' ')

      const targetSlugs = new Set<string>()
      let match: RegExpExecArray | null
      const regex = new RegExp(wikilinkRegex.source, 'g')
      while ((match = regex.exec(fullText)) !== null) {
        targetSlugs.add(match[1].trim())
      }

      for (const targetSlug of targetSlugs) {
        const targetId = slugToId.get(targetSlug)
        if (!targetId || targetId === concept.id) continue

        const existingFwd = await db
          .select({ id: wikiRelationships.id })
          .from(wikiRelationships)
          .where(and(
            eq(wikiRelationships.sourceConceptId, concept.id),
            eq(wikiRelationships.targetConceptId, targetId),
          ))
          .limit(1)

        if (existingFwd.length === 0) {
          try {
            await db.insert(wikiRelationships).values({
              id: `wiki_rel_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
              collectionId,
              sourceConceptId: concept.id,
              targetConceptId: targetId,
              relationshipType: 'related',
              strength: 1,
              createdAt: new Date(),
            })
          } catch {}
        }
      }
    }
  }

  private async applyLintFixes(
    collectionId: string,
    lintResults: Array<{ type: string; page: string; detail: string }>
  ): Promise<void> {
    const orphanNames = lintResults.filter(r => r.type === 'orphan').map(r => r.page)

    if (orphanNames.length > 0) {
      const allConcepts = await db
        .select({ id: wikiConcepts.id, conceptName: wikiConcepts.conceptName, slug: wikiConcepts.slug, content: wikiConcepts.content })
        .from(wikiConcepts)
        .where(eq(wikiConcepts.collectionId, collectionId))

      const allConceptNames = allConcepts.map(c => c.conceptName)
      const conceptNameToId = new Map(allConcepts.map(c => [c.conceptName, c.id]))

      for (const orphanName of orphanNames) {
        const orphanConcept = allConcepts.find(c => c.conceptName === orphanName)
        if (!orphanConcept) continue
        const contentText = orphanConcept.content
          ? JSON.stringify(orphanConcept.content).slice(0, 3000)
          : ''
        try {
          const relPrompt = buildRelationExtractionPrompt([orphanName], allConceptNames, contentText)
          const { text } = await generateText({
            model: openaiChat(getDefaultChatModel()),
            system: relPrompt,
            messages: [{ role: 'user', content: '请为这个孤立概念推断与其他概念的关系。' }],
            maxOutputTokens: WikiCompilerService.RELATION_MAX_TOKENS,
            abortSignal: AbortSignal.timeout(WikiCompilerService.LLM_TIMEOUT_MS),
          })
          const relations = parseAndValidateRelations(text)
          const fixes = relations.map(r => ({
            id: orphanConcept.id,
            conceptName: orphanName,
            relatedConcepts: [{ name: r.target, type: r.type }],
          }))
          await this.buildRelationships(collectionId, fixes)
        } catch (fixErr: any) {
          console.warn(`[WikiCompiler] orphan 修复失败 (${orphanName}):`, fixErr.message)
        }
      }
    }

    const brokenLinks = lintResults.filter(r => r.type === 'broken_link')
    if (brokenLinks.length > 0) {
      const allSlugs = new Map(
        (await db
          .select({ slug: wikiConcepts.slug })
          .from(wikiConcepts)
          .where(eq(wikiConcepts.collectionId, collectionId))
        ).map(r => [r.slug, r.slug])
      )

      const brokenSlugRegex = /\[\[([^\]]+)\]\]/
      for (const lint of brokenLinks) {
        const match = lint.detail.match(brokenSlugRegex)
        if (!match) continue
        const brokenSlug = match[1].trim()

        const bestMatch = [...allSlugs.keys()].find(
          slug => slug.includes(brokenSlug) || brokenSlug.includes(slug)
        )

        if (bestMatch) {
          const concept = await db
            .select({ id: wikiConcepts.id, content: wikiConcepts.content })
            .from(wikiConcepts)
            .where(and(eq(wikiConcepts.collectionId, collectionId), eq(wikiConcepts.conceptName, lint.page)))
            .limit(1)
          if (concept[0]?.content) {
            const fixed = JSON.stringify(concept[0].content).replace(
              new RegExp(`\\[\\[${brokenSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]\\]`, 'g'),
              `[[${bestMatch}]]`
            )
            try {
              await db
                .update(wikiConcepts)
                .set({ content: JSON.parse(fixed), updatedAt: new Date() })
                .where(eq(wikiConcepts.id, concept[0].id))
            } catch {}
          }
        }
      }
    }
  }

  private async extractRelationsWithLLM(
    newConceptNames: string[],
    allConceptNames: string[],
    docContent: string
  ): Promise<Array<{ source: string; target: string; type: 'prerequisite' | 'parent-child' | 'related' }>> {
    try {
      const prompt = buildRelationExtractionPrompt(newConceptNames, allConceptNames, docContent)
      const { text } = await generateText({
        model: openaiChat(getDefaultChatModel()),
        system: prompt,
        messages: [{ role: 'user', content: '请推断以上概念间的关系。' }],
        maxOutputTokens: WikiCompilerService.RELATION_MAX_TOKENS,
        abortSignal: AbortSignal.timeout(WikiCompilerService.LLM_TIMEOUT_MS),
      })
      return parseAndValidateRelations(text)
    } catch (err: any) {
      console.warn('[WikiCompiler] 独立关系提取失败:', err.message)
      return []
    }
  }
}
