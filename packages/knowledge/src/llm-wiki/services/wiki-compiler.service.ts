/**
 * WikiCompilerService - Phase 1：从文档中提取概念并存储到数据库
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
import { db, wikiConcepts, wikiConceptSources, wikiCompileTasks, documents, wikiRelationships } from '../db/index.js'
import { eq, and, sql } from 'drizzle-orm'
import { tiptapToMarkdownLLM } from '../../utils/tiptap-to-markdown-llm.js'
import { tiptapToMarkdown } from '../../utils/tiptap-to-markdown.js'
import { WikiCollectionService } from './wiki-collection.service.js'
import {
  buildExtractionPrompt,
  parseAndValidateExtraction,
  buildRelationExtractionPrompt,
  parseAndValidateRelations,
  buildPagePrompt,
  parseAndValidatePageContent,
  buildIndexPagePrompt,
  conceptToSlug,
  type ExtractedConcept,
  type ConceptRelation,
} from './wiki-prompts.js'
import type { WikiCompileTask, WikiCompileProgress, WikiCompileTaskStatus, WikiCompilePhase } from '../types/wiki.types.js'

/** db 与事务 tx 可互换的查询执行器 */
type QueryRunner = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]

export class WikiCompilerService {
  private static readonly EXTRACTION_MAX_TOKENS = 2000
  private static readonly RELATION_MAX_TOKENS = 1500
  private static readonly PAGE_GEN_MAX_TOKENS = 3000
  private static readonly MAX_SOURCE_CHARS = 30000

  constructor(
    private wikiCollectionService: WikiCollectionService
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
    // 1. 获取或创建 Wiki 集合
    const collection = await this.wikiCollectionService.getOrCreateCollection(knowledgeBaseId)

    // 2. 检查编译锁定：如果有正在运行的任务，抛出错误
    if (await this.hasRunningTask(collection.id)) {
      throw new Error(
        `Knowledge base ${knowledgeBaseId} already has a running compile task. Please wait for it to complete.`
      )
    }

    // 3. 创建编译任务记录（status='running'）
    const taskId = this.generateTaskId()
    const now = new Date()
    const initialProgress: WikiCompileProgress = {
      total: 0,
      processed: 0,
      skipped: 0,
      failed: 0,
      extracted: 0
    }

    await db.insert(wikiCompileTasks).values({
      id: taskId,
      collectionId: collection.id,
      knowledgeBaseId,
      status: 'running' as WikiCompileTaskStatus,
      progress: initialProgress,
      startedAt: now,
      createdAt: now,
      updatedAt: now
    })

    // 4. 后台异步执行编译，不等待，立即返回 taskId
    this.runCompilation(taskId, collection.id, knowledgeBaseId).catch((error) => {
      console.error(`[WikiCompiler] 编译任务 ${taskId} 发生未捕获错误:`, error)
    })

    return taskId
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

    if (await this.hasRunningTask(collection.id)) {
      throw new Error(
        `Knowledge base ${knowledgeBaseId} already has a running compile task. Please wait for it to complete.`
      )
    }

    const taskId = this.generateTaskId()
    const now = new Date()
    await db.insert(wikiCompileTasks).values({
      id: taskId,
      collectionId: collection.id,
      knowledgeBaseId,
      status: 'running' as WikiCompileTaskStatus,
      progress: { total: 1, processed: 0, skipped: 0, failed: 0, extracted: 0 },
      startedAt: now,
      createdAt: now,
      updatedAt: now,
    })

    this.runCompilation(taskId, collection.id, knowledgeBaseId, documentId).catch((error) => {
      console.error(`[WikiCompiler] 单文档编译任务 ${taskId} 发生未捕获错误:`, error)
    })

    return taskId
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
      const results = await db
        .select()
        .from(wikiCompileTasks)
        .where(
          and(
            eq(wikiCompileTasks.collectionId, collectionId),
            eq(wikiCompileTasks.status, 'running')
          )
        )
        .limit(1)

      return results.length > 0
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
  ): Promise<void> {
    const progress: WikiCompileProgress = {
      total: 0,
      processed: 0,
      skipped: 0,
      failed: 0,
      extracted: 0
    }

    try {
      // a. 获取知识库下所有文档（Wiki 只需要原始内容，不依赖分块/向量化状态）
      const docs = await db
        .select()
        .from(documents)
        .where(
          targetDocumentId
            ? and(eq(documents.knowledgeBaseId, knowledgeBaseId), eq(documents.id, targetDocumentId))
            : eq(documents.knowledgeBaseId, knowledgeBaseId)
        )

      progress.total = docs.length
      progress.phase = 'extracting' as WikiCompilePhase
      await this.updateTaskProgress(taskId, progress)

      // 获取集合中所有已有概念名称（用于提示词去重）
      const existingConcepts = await db
        .select({ conceptName: wikiConcepts.conceptName })
        .from(wikiConcepts)
        .where(eq(wikiConcepts.collectionId, collectionId))

      const existingConceptNames = existingConcepts.map((c) => c.conceptName)

      // Phase 2 数据收集（在 Phase 1 循环中填充）
      const conceptSourceMap = new Map<string, string[]>()   // conceptId -> sourceContents[]
      const conceptNameMap = new Map<string, string>()        // conceptId -> conceptName
      const conceptRelationsMap = new Map<string, Array<{name: string; type: string}>>()
 // conceptId -> relatedConcepts with types

      const EXTRACT_CONCURRENCY = parseInt(process.env.WIKI_EXTRACT_CONCURRENCY || '3')
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

      await Promise.all(docs.map(async (doc) => {
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

          const existingSources = await db
            .select()
            .from(wikiConceptSources)
            .where(eq(wikiConceptSources.documentId, doc.id))
            .limit(1)

          if (existingSources.length > 0 && existingSources[0].contentHash === contentHash) {
            progress.skipped++
            progress.processed++
            await this.updateTaskProgress(taskId, progress)
            return
          }

          if (existingSources.length > 0 && existingSources[0].contentHash !== contentHash) {
            const staleConceptIds = await db
              .select({ conceptId: wikiConceptSources.conceptId })
              .from(wikiConceptSources)
              .where(eq(wikiConceptSources.documentId, doc.id))
            for (const { conceptId } of staleConceptIds) {
              await db
                .update(wikiConcepts)
                .set({ status: 'outdated', updatedAt: new Date() })
                .where(and(eq(wikiConcepts.id, conceptId), eq(wikiConcepts.collectionId, collectionId)))
            }
          }

          const extractedConcepts = await this.extractConceptsWithRetry(
            markdownContent,
            [...existingConceptNames],
            doc.id
          )

          if (extractedConcepts === null || extractedConcepts.length === 0) {
            const existingConceptIds = await db
              .select({ conceptId: wikiConceptSources.conceptId })
              .from(wikiConceptSources)
              .where(eq(wikiConceptSources.documentId, doc.id))
            if (existingConceptIds.length > 0) {
              for (const { conceptId } of existingConceptIds) {
                await db
                  .update(wikiConcepts)
                  .set({ status: 'no_concepts', updatedAt: new Date() })
                  .where(eq(wikiConcepts.id, conceptId))
              }
            }
            if (extractedConcepts === null) {
              progress.failed++
            } else {
              progress.skipped++
            }
            progress.processed++
            await this.updateTaskProgress(taskId, progress)
            return
          }

          await db.transaction(async (tx) => {
            for (const concept of extractedConcepts) {
              const conceptId = await this.storeConcept(concept, collectionId, doc.id, contentHash, tx)
              if (!existingConceptNames.includes(concept.concept)) {
                existingConceptNames.push(concept.concept)
              }
              if (!conceptSourceMap.has(conceptId)) {
                conceptSourceMap.set(conceptId, [])
                conceptNameMap.set(conceptId, concept.concept)
                const normalized = (concept.related_concepts || []).map(r =>
                  typeof r === 'string' ? { name: r, type: 'related' } : { name: r.name, type: r.type || 'related' }
                )
                conceptRelationsMap.set(conceptId, normalized)
              }
              conceptSourceMap.get(conceptId)!.push(markdownContent)
            }
          })

          progress.extracted += extractedConcepts.length
          progress.processed++
          await this.updateTaskProgress(taskId, progress)
        } catch (docError: any) {
          console.error(`[WikiCompiler] 处理文档 ${doc.id} 时出错:`, docError)
          progress.failed++
          progress.processed++
          await this.updateTaskProgress(taskId, progress)
        } finally {
          releaseExtract()
        }
      }))

      const allConceptsInCollection = await db
        .select({ id: wikiConcepts.id, conceptName: wikiConcepts.conceptName })
        .from(wikiConcepts)
        .where(eq(wikiConcepts.collectionId, collectionId))

      const allConceptNames = allConceptsInCollection.map((c) => c.conceptName)

      progress.phase = 'extracting_relations' as WikiCompilePhase
      await this.updateTaskProgress(taskId, progress)

      const newConceptNames = Array.from(conceptNameMap.values())
      if (newConceptNames.length > 0 && allConceptNames.length > 1) {
        const docContents = Array.from(new Set(
          Array.from(conceptSourceMap.values()).flat()
        )).join('\n\n---\n\n').slice(0, 8000)

        const relations = await this.extractRelationsWithLLM(newConceptNames, allConceptNames, docContents)
        for (const rel of relations) {
          const sourceId = allConceptsInCollection.find(c => c.conceptName === rel.source)?.id
          if (!sourceId) continue
          const existing = conceptRelationsMap.get(sourceId) || []
          if (!existing.some(e => e.name === rel.target)) {
            existing.push({ name: rel.target, type: rel.type })
            conceptRelationsMap.set(sourceId, existing)
          }
        }
      }

      progress.phase = 'generating_pages' as WikiCompilePhase
      progress.pagesToGenerate = conceptSourceMap.size
      progress.pagesGenerated = 0
      await this.updateTaskProgress(taskId, progress)

      const PAGE_GEN_CONCURRENCY = parseInt(process.env.WIKI_PAGE_GEN_CONCURRENCY || '5')
      const conceptEntries = Array.from(conceptSourceMap.entries())

      const runWithConcurrency = async <T>(
        items: T[],
        fn: (item: T) => Promise<void>,
        concurrency: number,
      ) => {
        let idx = 0
        const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
          while (idx < items.length) {
            const item = items[idx++]
            await fn(item)
          }
        })
        await Promise.all(workers)
      }

      await runWithConcurrency(
        conceptEntries,
        async ([conceptId, sourceContents]) => {
          const conceptName = conceptNameMap.get(conceptId) || ''
          const relatedConcepts = conceptRelationsMap.get(conceptId) || []
          const validRelated = relatedConcepts.filter((n) => allConceptNames.includes(n.name))

          const success = await this.generateConceptPage(conceptId, conceptName, sourceContents, validRelated.map(r => r.name))
          if (!success) {
            console.warn(`[WikiCompiler] 概念 ${conceptName} 页面生成失败，跳过继续`)
          }
          progress.pagesGenerated = (progress.pagesGenerated ?? 0) + 1
          await this.updateTaskProgress(taskId, progress)
        },
        PAGE_GEN_CONCURRENCY,
      )

      try {
        progress.phase = 'building_relations' as WikiCompilePhase
        await this.updateTaskProgress(taskId, progress)

        const conceptsForRelations = Array.from(conceptRelationsMap.entries()).map(([id, relatedConcepts]) => ({
          id,
          conceptName: conceptNameMap.get(id) || '',
          relatedConcepts,
        }))

        await db.transaction(async (tx) => {
          await this.buildRelationships(collectionId, conceptsForRelations, tx)
        })

        await this.buildBacklinksFromContent(collectionId)
      } catch (relError: any) {
        console.error(`[WikiCompiler] 关系图谱构建失败:`, relError)
      }

      // 6a. 生成 _index 概念页
      try {
        progress.phase = 'generating_index' as WikiCompilePhase
        await this.updateTaskProgress(taskId, progress)
        await this.generateIndexPage(collectionId, taskId)
      } catch (indexError: any) {
        console.warn(`[WikiCompiler] Index 页面生成失败:`, indexError?.message)
      }

      try {
        progress.phase = 'linting' as WikiCompilePhase
        await this.updateTaskProgress(taskId, progress)
        const { WikiLintService } = await import('./wiki-lint.service.js')
        const lintService = new WikiLintService()
        const lintResults = await lintService.runStructuralLint(collectionId)

        await this.applyLintFixes(collectionId, lintResults)

        const finalLintResults = await lintService.runStructuralLint(collectionId)
        progress.lintResults = finalLintResults
      } catch (lintError: any) {
        console.warn(`[WikiCompiler] Lint 执行失败:`, lintError?.message)
      }
      progress.phase = 'done' as WikiCompilePhase
      await db
        .update(wikiCompileTasks)
        .set({
          status: 'completed' as WikiCompileTaskStatus,
          progress,
          completedAt: new Date(),
          updatedAt: new Date()
        })
        .where(eq(wikiCompileTasks.id, taskId))

      // 更新集合的最后编译时间和概念数量
      const allConcepts = await db
        .select({ id: wikiConcepts.id })
        .from(wikiConcepts)
        .where(eq(wikiConcepts.collectionId, collectionId))

      await this.wikiCollectionService.updateCollection(collectionId, {
        lastCompiledAt: new Date(),
        conceptCount: allConcepts.length
      })
    } catch (error: any) {
      // 7. 编译失败 → 更新任务状态，记录错误
      console.error(`[WikiCompiler] 任务 ${taskId} 编译失败:`, error)

      await db
        .update(wikiCompileTasks)
        .set({
          status: 'failed' as WikiCompileTaskStatus,
          progress,
          error: error.message,
          completedAt: new Date(),
          updatedAt: new Date()
        })
        .where(eq(wikiCompileTasks.id, taskId))

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
    documentId: string
  ): Promise<ExtractedConcept[] | null> {
    const truncated = content.length > WikiCompilerService.MAX_SOURCE_CHARS
      ? content.slice(0, WikiCompilerService.MAX_SOURCE_CHARS) + '\n\n[文档内容已截断]'
      : content
    const prompt = buildExtractionPrompt(truncated, existingConcepts)

    // 第一次尝试
    let rawOutput: string
    try {
      const { text } = await generateText({
        model: openaiChat(getDefaultChatModel()),
        system: prompt,
        messages: [{ role: 'user', content: '请提取文档中的关键概念。' }],
        maxOutputTokens: WikiCompilerService.EXTRACTION_MAX_TOKENS
      })
      rawOutput = text
    } catch (error: any) {
      console.error(`[WikiCompiler] LLM 调用失败（文档 ${documentId}）:`, error)
      return null
    }

    const concepts = parseAndValidateExtraction(rawOutput)

    // 第一次成功
    if (concepts.length > 0) {
      return concepts
    }

    // 检查输出是否包含 "concepts" 关键字
    // 若不包含，说明格式严重错误，触发重试
    // 若包含但解析为空，说明文档可能真的没有重要概念（仍重试，以防误判）
    console.warn(
      `[WikiCompiler] 文档 ${documentId} 第一次提取结果为空，触发重试...`
    )

    const retryPrompt =
      prompt +
      '\n\n【重要提示】上次输出格式不正确或未提取到概念。请确保以有效 JSON 格式返回结果，格式示例：' +
      '{"concepts": [{"concept": "概念名", "summary": "一句话描述", "is_new": true, "tags": [], "related_concepts": []}]}'

    try {
      const { text: retryText } = await generateText({
        model: openaiChat(getDefaultChatModel()),
        system: retryPrompt,
        messages: [
          {
            role: 'user',
            content: '请重新提取文档中的关键概念，确保返回正确的 JSON 格式。'
          }
        ],
        maxOutputTokens: WikiCompilerService.EXTRACTION_MAX_TOKENS
      })

      return parseAndValidateExtraction(retryText)
    } catch (error: any) {
      console.error(`[WikiCompiler] LLM 重试失败（文档 ${documentId}）:`, error)
      return null
    }
  }

  /**
   * 将提取到的单个概念存储到数据库
   * - 不存在 → INSERT wiki_concepts
   * - 已存在 → 更新 occurrence_count
   * - 无论如何都 INSERT/UPDATE wiki_concept_sources
   */
  async storeConcept(
    concept: ExtractedConcept,
    collectionId: string,
    documentId: string,
    contentHash: string,
    queryRunner: QueryRunner = db
  ): Promise<string> {
    const slug = conceptToSlug(concept.concept)

    const aliasTags = (concept.aliases || []).map((a: string) => `alias:${a}`)
    const mergedTags = [...(concept.tags || []), ...aliasTags]

    // 检查 slug 是否已存在（去重）
    const [existingConcept] = await queryRunner
      .select()
      .from(wikiConcepts)
      .where(
        and(
          eq(wikiConcepts.collectionId, collectionId),
          eq(wikiConcepts.slug, slug)
        )
      )
      .limit(1)

    let conceptId: string

    if (!existingConcept) {
      // 不存在 → INSERT wiki_concepts
      conceptId = this.generateConceptId()
      await queryRunner.insert(wikiConcepts).values({
        id: conceptId,
        collectionId,
        conceptName: concept.concept,
        slug,
        definition: concept.definition || null,
        summary: concept.summary,
        tags: mergedTags,
        occurrenceCount: 1,
        status: 'compiled',
        createdAt: new Date(),
        updatedAt: new Date()
      })
    } else {
      conceptId = existingConcept.id
      await queryRunner
        .update(wikiConcepts)
        .set({
          occurrenceCount: (existingConcept.occurrenceCount || 1) + 1,
          status: 'compiled',
          updatedAt: new Date()
        })
        .where(eq(wikiConcepts.id, conceptId))
    }

    // 检查 wiki_concept_sources 中该文档-概念关联是否已存在
    const [existingSource] = await queryRunner
      .select()
      .from(wikiConceptSources)
      .where(
        and(
          eq(wikiConceptSources.conceptId, conceptId),
          eq(wikiConceptSources.documentId, documentId)
        )
      )
      .limit(1)

    if (!existingSource) {
      // INSERT 新的来源记录
      await queryRunner.insert(wikiConceptSources).values({
        id: this.generateSourceId(),
        conceptId,
        documentId,
        contentHash,
        compiledAt: new Date()
      })
    } else {
      // 更新哈希（文档内容已改变）
      await queryRunner
        .update(wikiConceptSources)
        .set({
          contentHash,
          compiledAt: new Date()
        })
        .where(eq(wikiConceptSources.id, existingSource.id))
    }

    return conceptId
  }

  // ─── 内部辅助方法 ─────────────────────────────────────────────────────────────

  async generateConceptPage(
    conceptId: string,
    conceptName: string,
    sourceContents: string[],
    relatedConceptNames?: string[]
  ): Promise<boolean> {
    const sourceContent = sourceContents.join('\n\n---\n\n')
    const truncated = sourceContent.length > WikiCompilerService.MAX_SOURCE_CHARS
      ? sourceContent.slice(0, WikiCompilerService.MAX_SOURCE_CHARS) + '\n\n[源材料已截断]'
      : sourceContent
    const prompt = buildPagePrompt(conceptName, truncated, undefined, relatedConceptNames)

    try {
      const { text } = await generateText({
        model: openaiChat(getDefaultChatModel()),
        system: prompt,
        messages: [{ role: 'user', content: '请为这个概念生成 Wiki 页面。' }],
        maxOutputTokens: WikiCompilerService.PAGE_GEN_MAX_TOKENS
      })

      const pageContent = parseAndValidatePageContent(text)
      if (!pageContent) return false

      if (relatedConceptNames && relatedConceptNames.length > 0) {
        const slugMap = new Map<string, string>(
          relatedConceptNames.map((name) => [name, conceptToSlug(name)])
        )
        pageContent.sections = pageContent.sections.map((section) => ({
          ...section,
          content: this.resolveWikiLinks(section.content, slugMap)
        }))
      }

      await db
        .update(wikiConcepts)
        .set({ content: pageContent, updatedAt: new Date() })
        .where(eq(wikiConcepts.id, conceptId))

      return true
    } catch (error) {
      console.error(`[WikiCompiler] 概念 ${conceptName} 页面生成失败:`, error)
      return false
    }
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
    concepts: Array<{ id: string; conceptName: string; relatedConcepts: Array<{name: string; type: string}> }>,
    queryRunner: QueryRunner = db
  ): Promise<void> {
    const allConceptsInCollection = await queryRunner
      .select({ id: wikiConcepts.id, conceptName: wikiConcepts.conceptName, slug: wikiConcepts.slug })
      .from(wikiConcepts)
      .where(eq(wikiConcepts.collectionId, collectionId))

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
    await db
      .update(wikiCompileTasks)
      .set({
        progress,
        updatedAt: new Date()
      })
      .where(eq(wikiCompileTasks.id, taskId))
  }

  private mapRowToTask(row: Record<string, unknown>): WikiCompileTask {
    return {
      id: row.id as string,
      collectionId: row.collectionId as string,
      knowledgeBaseId: row.knowledgeBaseId as string,
      status: row.status as WikiCompileTaskStatus,
      progress: row.progress as WikiCompileProgress,
      error: (row.error as string) || undefined,
      startedAt: (row.startedAt as Date) || undefined,
      completedAt: (row.completedAt as Date) || undefined,
      createdAt: row.createdAt as Date,
      updatedAt: row.updatedAt as Date
    }
  }

  private async generateIndexPage(collectionId: string, _taskId: string): Promise<void> {
    const concepts = await db
      .select({
        id: wikiConcepts.id,
        conceptName: wikiConcepts.conceptName,
        summary: wikiConcepts.summary,
        tags: wikiConcepts.tags,
        slug: wikiConcepts.slug,
      })
      .from(wikiConcepts)
      .where(
        and(
          eq(wikiConcepts.collectionId, collectionId),
          sql`${wikiConcepts.slug} != '_index'`
        )
      )

    if (concepts.length === 0) return

    const relationships = await db
      .select({
        sourceConceptId: wikiRelationships.sourceConceptId,
        targetConceptId: wikiRelationships.targetConceptId,
        relationshipType: wikiRelationships.relationshipType,
      })
      .from(wikiRelationships)
      .where(eq(wikiRelationships.collectionId, collectionId))

      const conceptSummaryList = concepts.map(c => ({
        conceptName: c.conceptName,
        summary: c.summary || '',
        tags: (c.tags || []) as string[]
      }))

      const { text } = await generateText({
      model: openaiChat(getDefaultChatModel()),
      system: buildIndexPagePrompt(conceptSummaryList, relationships.length, concepts.length),
      messages: [{ role: 'user', content: '请生成 Wiki Index 页面。' }],
      maxOutputTokens: 2000,
    })

    const indexContent = parseAndValidatePageContent(text)

    const existingIndex = await db
      .select({ id: wikiConcepts.id })
      .from(wikiConcepts)
      .where(
        and(
          eq(wikiConcepts.collectionId, collectionId),
          eq(wikiConcepts.slug, '_index')
        )
      )
      .limit(1)

    if (existingIndex.length > 0) {
      await db
        .update(wikiConcepts)
        .set({
          content: indexContent,
          summary: 'Wiki Index - 概念总览与导航',
          updatedAt: new Date(),
        })
        .where(eq(wikiConcepts.id, existingIndex[0].id))
    } else {
      await db.insert(wikiConcepts).values({
        id: this.generateConceptId(),
        collectionId,
        conceptName: '_index',
        slug: '_index',
        summary: 'Wiki Index - 概念总览与导航',
        content: indexContent,
        tags: ['system', 'index'],
        occurrenceCount: 0,
        status: 'compiled',
        createdAt: new Date(),
        updatedAt: new Date(),
      })
    }
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
      })
      return parseAndValidateRelations(text)
    } catch (err: any) {
      console.warn('[WikiCompiler] 独立关系提取失败:', err.message)
      return []
    }
  }
}
