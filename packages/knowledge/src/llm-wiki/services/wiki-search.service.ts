import { db, wikiConcepts, wikiConceptSources, pool, schemaName } from '../db/index.js'
import { eq, and } from 'drizzle-orm'
import { WikiCollectionService } from './wiki-collection.service.js'
import type { WikiConcept, WikiSearchResultItem, WikiSearchResponse, WikiPageContent, WikiConceptStatus } from '../types/wiki.types.js'

export interface TokenSearchResult {
  concept: WikiConcept
  score: number
  titleMatch: boolean
  phraseMatch: boolean
}

const STOP_WORDS = new Set([
  '的', '是', '了', '什么', '在', '有', '和', '与', '对', '从',
  'the', 'is', 'a', 'an', 'what', 'how', 'are', 'was', 'were',
  'do', 'does', 'did', 'be', 'been', 'being', 'have', 'has', 'had',
  'it', 'its', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by',
  'this', 'that', 'these', 'those',
])

export function tokenizeQuery(query: string): string[] {
  const rawTokens = query
    .toLowerCase()
    .split(/[\s,，。！？、；：""''（）()\-_/\\·~～…]+/)
    .filter((t) => t.length > 1)
    .filter((t) => !STOP_WORDS.has(t))

  const tokens: string[] = []

  for (const token of rawTokens) {
    const hasCJK = /[\u4e00-\u9fff\u3400-\u4dbf]/.test(token)

    if (hasCJK && token.length > 2) {
      const chars = [...token]
      for (let i = 0; i < chars.length - 1; i++) {
        tokens.push(chars[i] + chars[i + 1])
      }
      for (const ch of chars) {
        if (!STOP_WORDS.has(ch)) {
          tokens.push(ch)
        }
      }
      tokens.push(token)
    } else {
      tokens.push(token)
    }
  }

  return [...new Set(tokens)]
}

function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4)
}

export class WikiSearchService {
  constructor(private wikiCollectionService: WikiCollectionService) {}

  async searchConcepts(
    knowledgeBaseId: string,
    query: string,
    options?: { topK?: number }
  ): Promise<WikiConcept[]> {
    const results = await this.searchConceptsScored(knowledgeBaseId, query, options)
    return results.map(r => r.concept)
  }

  async searchConceptsScored(
    knowledgeBaseId: string,
    query: string,
    options?: { topK?: number }
  ): Promise<TokenSearchResult[]> {
    const topK = options?.topK || 10

    const collection = await this.wikiCollectionService.getCollectionByKnowledgeBaseId(knowledgeBaseId)
    if (!collection) return []

    const client = await pool.connect()
    try {
      await client.query(`SET search_path TO ${schemaName}, public`)

      const escaped = query.replace(/[%_']/g, '\\$&')
      const queryLower = query.toLowerCase()
      const escapedLower = queryLower.replace(/[%_']/g, '\\$&')
      const tokens = tokenizeQuery(query)
      const effectiveTokens = tokens.length > 0 ? tokens : [queryLower]

      const uniqueTokens = [...new Set(effectiveTokens.map(t => t.toLowerCase()))]
        .filter(t => t.length >= 2 || /[\u4e00-\u9fff]/.test(t))
        .slice(0, 20)

      const likeConditions: string[] = []
      const likeParams: string[] = []
      const scoreCases: string[] = []

      let sql: string
      let params: unknown[]

      for (const token of uniqueTokens) {
        const escapedToken = token.replace(/[%_']/g, '\\$&')
        const paramIdx = likeParams.push(escapedToken)
        const isFullQuery = token === queryLower

        const nameScore = isFullQuery ? 50 : 20
        const summaryScore = isFullQuery ? 20 : 8
        const defScore = isFullQuery ? 10 : 4
        const tagScore = isFullQuery ? 30 : 12
        const contentScore = isFullQuery ? 6 : 2
        const p = `$${paramIdx + 2}`

        likeConditions.push(
          `LOWER(c.concept_name) LIKE '%' || ${p} || '%' ESCAPE '\\'`,
          `LOWER(c.definition) LIKE '%' || ${p} || '%' ESCAPE '\\'`,
          `LOWER(c.summary) LIKE '%' || ${p} || '%' ESCAPE '\\'`,
          `EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(c.tags, '[]'::jsonb)) t WHERE LOWER(t) LIKE '%' || ${p} || '%' ESCAPE '\\')`,
          `LOWER(COALESCE(c.content::text, '')) LIKE '%' || ${p} || '%' ESCAPE '\\'`,
        )
        scoreCases.push(
          `CASE WHEN LOWER(c.concept_name) LIKE '%' || ${p} || '%' ESCAPE '\\' THEN ${nameScore} ELSE 0 END`,
          `CASE WHEN LOWER(c.summary) LIKE '%' || ${p} || '%' ESCAPE '\\' THEN ${summaryScore} ELSE 0 END`,
          `CASE WHEN LOWER(c.definition) LIKE '%' || ${p} || '%' ESCAPE '\\' THEN ${defScore} ELSE 0 END`,
          `CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(c.tags, '[]'::jsonb)) t WHERE LOWER(t) LIKE '%' || ${p} || '%' ESCAPE '\\') THEN ${tagScore} ELSE 0 END`,
          `CASE WHEN LOWER(COALESCE(c.content::text, '')) LIKE '%' || ${p} || '%' ESCAPE '\\' THEN ${contentScore} ELSE 0 END`,
        )
      }

      scoreCases.push(
        `CASE WHEN LOWER(c.concept_name) = $${likeParams.length + 3} THEN 200 ELSE 0 END`,
        `COALESCE(ts_rank(
          setweight(to_tsvector('simple', COALESCE(c.concept_name, '')), 'A') ||
          setweight(to_tsvector('simple', COALESCE(c.summary, '')), 'B') ||
          setweight(to_tsvector('simple', COALESCE(c.definition, '')), 'C'),
          plainto_tsquery('simple', $${likeParams.length + 3})
        ) * 15, 0)`,
      )

      sql = `
        SELECT c.*,
          ${scoreCases.join(' + ')} AS score,
          CASE WHEN LOWER(c.concept_name) LIKE '%' || $${likeParams.length + 3} || '%' ESCAPE '\\' THEN true ELSE false END AS title_match,
          CASE WHEN LOWER(c.summary) LIKE '%' || $${likeParams.length + 3} || '%' ESCAPE '\\' THEN true ELSE false END AS phrase_match
        FROM ${schemaName}.wiki_concepts c
        WHERE c.collection_id = $1
          AND c.status != 'failed'
          AND (
            ${likeConditions.join('\n            OR ')}
            OR to_tsvector('simple', COALESCE(c.concept_name, '') || ' ' || COALESCE(c.summary, '') || ' ' || COALESCE(c.definition, ''))
               @@ plainto_tsquery('simple', $${likeParams.length + 3})
          )
        ORDER BY score DESC
        LIMIT $2
      `
      params = [collection.id, topK, ...likeParams, escapedLower]

      const result = await client.query(sql, params)

      return result.rows.map((row: Record<string, unknown>) => ({
        concept: this.mapRowToConcept(row),
        score: parseFloat(String(row.score)) || 0,
        titleMatch: row.title_match === true || row.title_match === 't',
        phraseMatch: row.phrase_match === true || row.phrase_match === 't',
      }))
    } finally {
      client.release()
    }
  }

  async getRelatedConcepts(
    conceptId: string,
    depth: number = 2
  ): Promise<WikiConcept[]> {
    const maxDepth = Math.min(depth, 3)
    const client = await pool.connect()

    try {
      await client.query(`SET search_path TO ${schemaName}, public`)

      const result = await client.query(`
        WITH RECURSIVE concept_graph AS (
          SELECT 
            r.target_concept_id as concept_id,
            1 as depth,
            ARRAY[r.source_concept_id]::text[] as path
          FROM ${schemaName}.wiki_relationships r
          WHERE r.source_concept_id = $1
          
          UNION ALL
          
          SELECT
            r.target_concept_id,
            cg.depth + 1,
            cg.path || r.source_concept_id
          FROM ${schemaName}.wiki_relationships r
          JOIN concept_graph cg ON r.source_concept_id = cg.concept_id
          WHERE 
            cg.depth < $2
            AND r.target_concept_id <> ALL(cg.path)
            AND r.target_concept_id != $1
        )
        SELECT DISTINCT c.*
        FROM concept_graph cg
        JOIN ${schemaName}.wiki_concepts c ON c.id = cg.concept_id
        WHERE c.status != 'failed'
      `, [conceptId, maxDepth])

      return result.rows.map((row: Record<string, unknown>) => this.mapRowToConcept(row))
    } finally {
      client.release()
    }
  }

  async getConceptBySlug(collectionId: string, slug: string): Promise<WikiConcept | null> {
    const [result] = await db
      .select()
      .from(wikiConcepts)
      .where(
        and(
          eq(wikiConcepts.collectionId, collectionId),
          eq(wikiConcepts.slug, slug)
        )
      )

    if (!result) return null
    return this.mapRowToConcept(result)
  }

  async getConceptSources(conceptId: string): Promise<string[]> {
    const results = await db
      .select()
      .from(wikiConceptSources)
      .where(eq(wikiConceptSources.conceptId, conceptId))

    return results.map(row => row.documentId)
  }

  async getConceptDetail(collectionId: string, conceptId: string): Promise<WikiConcept | null> {
    const [result] = await db
      .select()
      .from(wikiConcepts)
      .where(
        and(
          eq(wikiConcepts.collectionId, collectionId),
          eq(wikiConcepts.id, conceptId)
        )
      )

    if (!result) return null
    return this.mapRowToConcept(result)
  }

  async search(
    knowledgeBaseId: string,
    query: string,
    options?: { topK?: number; includeRelated?: boolean; depth?: number }
  ): Promise<WikiSearchResponse> {
    const concepts = await this.searchConcepts(knowledgeBaseId, query, { topK: options?.topK })

    const results: WikiSearchResultItem[] = await Promise.all(
      concepts.map(async (concept) => {
        const relatedConcepts = options?.includeRelated !== false
          ? await this.getRelatedConcepts(concept.id, options?.depth)
          : []

        const sourceDocumentIds = await this.getConceptSources(concept.id)

        return {
          concept,
          relatedConcepts,
          sourceDocumentIds
        }
      })
    )

    return {
      results,
      total: results.length
    }
  }

  private mapRowToConcept(row: Record<string, unknown>): WikiConcept {
    return {
      id: row.id as string,
      collectionId: (row.collectionId ?? row.collection_id) as string,
      conceptName: (row.conceptName ?? row.concept_name) as string,
      slug: row.slug as string,
      definition: (row.definition as string) || undefined,
      summary: (row.summary as string) || undefined,
      content: (row.content as WikiPageContent) || undefined,
      tags: (row.tags as string[]) || [],
      occurrenceCount: ((row.occurrenceCount ?? row.occurrence_count) as number) ?? 1,
      status: row.status as WikiConceptStatus,
      createdAt: (row.createdAt ?? row.created_at) as Date,
      updatedAt: (row.updatedAt ?? row.updated_at) as Date
    }
  }
}
