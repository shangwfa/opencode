import { db, wikiConcepts, wikiRelationships, wikiConceptSources, pool, schemaName } from '../db/index.js'
import { eq, sql } from 'drizzle-orm'
import { generateText } from 'ai'
import { openaiChat } from '../../providers/llm.js'
import { getDefaultChatModel } from '../../config/env.js'
import { buildLintPrompt, parseLintResults } from './wiki-prompts.js'
import type { WikiLintResult } from '../types/wiki.types.js'

export class WikiLintService {

  async runStructuralLint(collectionId: string): Promise<WikiLintResult[]> {
    const results: WikiLintResult[] = await this.detectOrphans(collectionId)
    results.push(...await this.detectBrokenLinks(collectionId))
    results.push(...await this.detectNoOutgoing(collectionId))
    return results
  }

  async runSemanticLint(collectionId: string): Promise<WikiLintResult[]> {
    const concepts = await db
      .select({
        id: wikiConcepts.id,
        conceptName: wikiConcepts.conceptName,
        summary: wikiConcepts.summary,
        tags: wikiConcepts.tags,
      })
      .from(wikiConcepts)
      .where(eq(wikiConcepts.collectionId, collectionId))

    if (concepts.length === 0) return []

    const summaries = concepts
      .map(c => `### ${c.conceptName}\n${c.summary || '(no summary)'}\ntags: ${JSON.stringify(c.tags)}`)
      .join('\n\n')

    const truncatedSummaries = summaries.length > 30000
      ? summaries.slice(0, 30000) + '\n\n[截断]'
      : summaries

    try {
      const { text } = await generateText({
        model: openaiChat(getDefaultChatModel()),
        system: buildLintPrompt(truncatedSummaries),
        messages: [{ role: 'user', content: '请审查 Wiki 质量。' }],
        maxOutputTokens: 2000,
      })

      const parsed = parseLintResults(text)
      return parsed.map(p => ({
        type: p.type as WikiLintResult['type'],
        severity: p.severity as WikiLintResult['severity'],
        page: p.title,
        detail: p.detail,
        affectedPages: p.affectedPages,
      }))
    } catch {
      return []
    }
  }

  async runLint(collectionId: string, includeSemantic: boolean = false): Promise<WikiLintResult[]> {
    const structural = await this.runStructuralLint(collectionId)
    if (!includeSemantic) return structural

    const semantic = await this.runSemanticLint(collectionId)
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
          AND c.status != 'failed'
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
      .where(eq(wikiConcepts.collectionId, collectionId))

    const allSlugs = new Set(
      (await db
        .select({ slug: wikiConcepts.slug })
        .from(wikiConcepts)
        .where(eq(wikiConcepts.collectionId, collectionId))
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
          AND c.status != 'failed'
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
