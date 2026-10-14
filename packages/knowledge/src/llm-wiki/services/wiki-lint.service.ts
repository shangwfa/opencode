import { db, wikiConcepts, wikiRelationships, wikiConceptSources, wikiPageRevisions, pool, schemaName } from '../db/index.js'
import { and, eq, or, sql, inArray } from 'drizzle-orm'
import { generateText } from 'ai'
import { openaiChat } from '../../providers/llm.js'
import { getDefaultChatModel } from '../../config/env.js'
import { buildLintPrompt, parseLintResults } from './wiki-prompts.js'
import { isRateLimitError } from './wiki-compiler.service.js'
import type { WikiLintResult } from '../types/wiki.types.js'

export class WikiLintService {

  async runStructuralLint(collectionId: string): Promise<WikiLintResult[]> {
    const results: WikiLintResult[] = await this.detectOrphans(collectionId)
    results.push(...await this.detectBrokenLinks(collectionId))
    results.push(...await this.detectNoOutgoing(collectionId))
    return results
  }

  /**
   * 语义 lint（页面级）：每页独立调用（材料 = 该页正文 + 来源快照）。
   * - 单页材料 ≤30k 天然安全（实测单页最大 ~18k）；超限/无效输出 → 该页记 skipped（info），不伪装无问题、不放大为全库失败；
   * - 限流快速失败（rethrow），避免逐页烧配额；
   * - options.conceptIds 指定增量审查范围（编译自动巡检只审本轮发布页）。
   */
  async runSemanticLint(collectionId: string, options?: { conceptIds?: string[] }): Promise<WikiLintResult[]> {
    const targets = options?.conceptIds?.length ? options.conceptIds : null
    const concepts = await db
      .select({
        id: wikiConcepts.id,
        conceptName: wikiConcepts.conceptName,
        summary: wikiConcepts.summary,
        tags: wikiConcepts.tags,
        content: wikiConcepts.content,
        revision: wikiConcepts.revision,
        citationStatus: wikiConcepts.citationStatus,
        sourceSnapshot: sql`(SELECT source_snapshot FROM ${wikiPageRevisions}
          WHERE concept_id = ${wikiConcepts.id} AND revision = ${wikiConcepts.revision} LIMIT 1)`,
      })
      .from(wikiConcepts)
      .where(and(eq(wikiConcepts.collectionId, collectionId),
        or(eq(wikiConcepts.status, 'compiled'), eq(wikiConcepts.status, 'needs_review')),
        ...(targets ? [inArray(wikiConcepts.id, targets)] : [])))

    if (concepts.length === 0) return []

    const results: WikiLintResult[] = []
    const CONCURRENCY = Math.max(1, parseInt(process.env.WIKI_LINT_CONCURRENCY || '3') || 3)
    let cursor = 0
    const workers = Array.from({ length: Math.min(CONCURRENCY, concepts.length) }, async () => {
      while (cursor < concepts.length) {
        const concept = concepts[cursor++]
        const materials = JSON.stringify([concept])
        if (materials.length > 30000) {
          results.push({ type: 'skipped', severity: 'info', page: concept.conceptName,
            detail: `单页材料 ${materials.length} 字符超过审查上限，跳过语义审查` })
          continue
        }
        try {
          const { text } = await generateText({
            model: openaiChat(getDefaultChatModel()),
            system: buildLintPrompt(materials),
            messages: [{ role: 'user', content: '请审查 Wiki 质量。' }],
            maxOutputTokens: 2000,
          })
          if (text.trim() === 'NO_ISSUES') continue
          const parsed = parseLintResults(text)
          if (parsed.length === 0) {
            results.push({ type: 'skipped', severity: 'info', page: concept.conceptName,
              detail: '语义审查输出无法解析，本页跳过（不伪装无问题）' })
            continue
          }
          results.push(...parsed.map(p => ({
            type: p.type as WikiLintResult['type'],
            severity: p.severity as WikiLintResult['severity'],
            page: p.title,
            detail: p.detail,
            affectedPages: p.affectedPages,
          })))
        } catch (error) {
          if (isRateLimitError(error)) throw error
          results.push({ type: 'skipped', severity: 'info', page: concept.conceptName,
            detail: `语义审查调用失败：${error instanceof Error ? error.message : String(error)}` })
        }
      }
    })
    await Promise.all(workers)
    return results
  }

  async runLint(collectionId: string, includeSemantic: boolean = false, options?: { conceptIds?: string[] }): Promise<WikiLintResult[]> {
    const structural = await this.runStructuralLint(collectionId)
    if (!includeSemantic) return structural

    const semantic = await this.runSemanticLint(collectionId, options)
    return [...structural, ...semantic]
  }

  private async detectOrphans(collectionId: string): Promise<WikiLintResult[]> {
    const client = await pool.connect()
    try {
      await client.query(`SET search_path TO ${schemaName}, public`)

      const result = await client.query(`
        SELECT c.id, c.concept_name, c.slug
        FROM ${schemaName}.wiki_concepts c
        WHERE c.collection_id = $1
          AND c.status = 'compiled'
          AND c.slug != '_index'
          AND NOT EXISTS (
            SELECT 1 FROM ${schemaName}.wiki_relationships r
            WHERE r.source_concept_id = c.id OR r.target_concept_id = c.id
          )
      `, [collectionId])

      return result.rows.map((row: Record<string, unknown>) => ({
        type: 'orphan' as const,
        severity: 'info' as const,
        page: row.concept_name as string,
        detail: `No relationships to other concepts.`,
      }))
    } finally {
      client.release()
    }
  }

  private async detectBrokenLinks(collectionId: string): Promise<WikiLintResult[]> {
    const concepts = await db
      .select({
        id: wikiConcepts.id,
        conceptName: wikiConcepts.conceptName,
        content: wikiConcepts.content,
      })
      .from(wikiConcepts)
      .where(and(eq(wikiConcepts.collectionId, collectionId), eq(wikiConcepts.status, 'compiled')))

    const allSlugs = new Set(
      (await db
        .select({ slug: wikiConcepts.slug })
        .from(wikiConcepts)
        .where(and(eq(wikiConcepts.collectionId, collectionId), eq(wikiConcepts.status, 'compiled')))
      ).map(r => r.slug)
    )

    const results: WikiLintResult[] = []
    const wikilinkRegex = /\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g

    for (const concept of concepts) {
      const content = concept.content as { sections?: Array<{ content: string }> } | null
      if (!content?.sections) continue

      const fullContent = content.sections.map(s => s.content).join(' ')
      let match: RegExpExecArray | null

      while ((match = wikilinkRegex.exec(fullContent)) !== null) {
        const targetSlug = match[1].trim().toLowerCase()
        if (!allSlugs.has(targetSlug)) {
          results.push({
            type: 'broken_link',
            severity: 'warning',
            page: concept.conceptName,
            detail: `Broken link: [[${match[1]}]] — target concept not found.`,
          })
        }
      }
    }

    return results
  }

  private async detectNoOutgoing(collectionId: string): Promise<WikiLintResult[]> {
    const client = await pool.connect()
    try {
      await client.query(`SET search_path TO ${schemaName}, public`)

      const result = await client.query(`
        SELECT c.id, c.concept_name
        FROM ${schemaName}.wiki_concepts c
        WHERE c.collection_id = $1
          AND c.status = 'compiled'
          AND c.slug != '_index'
          AND NOT EXISTS (
            SELECT 1 FROM ${schemaName}.wiki_relationships r
            WHERE r.source_concept_id = c.id
          )
      `, [collectionId])

      return result.rows.map((row: Record<string, unknown>) => ({
        type: 'no_outlinks' as const,
        severity: 'info' as const,
        page: row.concept_name as string,
        detail: `No outgoing relationships to other concepts.`,
      }))
    } finally {
      client.release()
    }
  }
}
