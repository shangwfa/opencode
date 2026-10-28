import { db, wikiConcepts, wikiRelationships, pool, schemaName } from '../db/index.js'
import { and, eq, desc, sql } from 'drizzle-orm'
import { WikiCollectionService } from './wiki-collection.service.js'
import type { WikiNavigateOverview, WikiGraphStats } from '../types/wiki.types.js'

export class WikiNavigateService {
  constructor(private wikiCollectionService: WikiCollectionService) {}

  async getOverview(collectionId: string): Promise<WikiNavigateOverview> {
    const conceptCountResult = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(wikiConcepts)
      .where(this.visibleConcepts(collectionId))

    const conceptCount = conceptCountResult[0]?.count ?? 0

    const relationshipCountResult = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(wikiRelationships)
      .where(this.visibleRelationships(collectionId))

    const relationshipCount = relationshipCountResult[0]?.count ?? 0

    const tagDistribution = await db
      .select({
        tag: sql<string>`jsonb_array_elements_text(tags)`,
        count: sql<number>`count(*)::int`,
      })
      .from(wikiConcepts)
      .where(this.visibleConcepts(collectionId))
      .groupBy(sql`jsonb_array_elements_text(tags)`)
      .orderBy(desc(sql`count(*)::int`))
      .limit(20)

    const recentConcepts = await db
      .select({
        id: wikiConcepts.id,
        conceptName: wikiConcepts.conceptName,
        updatedAt: wikiConcepts.updatedAt,
      })
      .from(wikiConcepts)
      .where(this.visibleConcepts(collectionId))
      .orderBy(desc(wikiConcepts.updatedAt))
      .limit(10)

    const topConcepts = await db
      .select({
        id: wikiConcepts.id,
        conceptName: wikiConcepts.conceptName,
        occurrenceCount: wikiConcepts.occurrenceCount,
      })
      .from(wikiConcepts)
      .where(this.visibleConcepts(collectionId))
      .orderBy(desc(wikiConcepts.occurrenceCount))
      .limit(10)

    const typeDistribution = await db
      .select({
        type: wikiRelationships.relationshipType,
        count: sql<number>`count(*)::int`,
      })
      .from(wikiRelationships)
      .where(this.visibleRelationships(collectionId))
      .groupBy(wikiRelationships.relationshipType)
      .orderBy(desc(sql`count(*)::int`))

    return {
      conceptCount,
      relationshipCount,
      tagDistribution,
      recentConcepts,
      topConcepts,
      relationshipTypeDistribution: typeDistribution,
    }
  }

  async getConceptsByTag(collectionId: string, tag: string) {
    return db
      .select({
        id: wikiConcepts.id,
        conceptName: wikiConcepts.conceptName,
        slug: wikiConcepts.slug,
        summary: wikiConcepts.summary,
        tags: wikiConcepts.tags,
        occurrenceCount: wikiConcepts.occurrenceCount,
      })
      .from(wikiConcepts)
      .where(
        and(this.visibleConcepts(collectionId), sql`${wikiConcepts.tags} @> ${JSON.stringify([tag])}::jsonb`)
      )
      .orderBy(desc(wikiConcepts.occurrenceCount))
  }

  async getConceptsByPage(collectionId: string, page: number = 1, pageSize: number = 20) {
    const offset = (page - 1) * pageSize

    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(wikiConcepts)
      .where(this.visibleConcepts(collectionId))

    const concepts = await db
      .select({
        id: wikiConcepts.id,
        conceptName: wikiConcepts.conceptName,
        slug: wikiConcepts.slug,
        summary: wikiConcepts.summary,
        tags: wikiConcepts.tags,
        occurrenceCount: wikiConcepts.occurrenceCount,
        updatedAt: wikiConcepts.updatedAt,
      })
      .from(wikiConcepts)
      .where(this.visibleConcepts(collectionId))
      .orderBy(desc(wikiConcepts.occurrenceCount))
      .limit(pageSize)
      .offset(offset)

    return {
      concepts,
      total: countResult?.count ?? 0,
      page,
      pageSize,
    }
  }

  async getGraphStats(collectionId: string): Promise<WikiGraphStats> {
    const client = await pool.connect()
    try {
      await client.query(`SET search_path TO ${schemaName}, public`)

      const statsResult = await client.query(`
        WITH degree_stats AS (
          SELECT
            c.id,
            c.concept_name,
            COUNT(r.id) AS degree
          FROM ${schemaName}.wiki_concepts c
          LEFT JOIN ${schemaName}.wiki_relationships r ON (
            (r.source_concept_id = c.id OR r.target_concept_id = c.id)
            AND r.collection_id = c.collection_id AND r.origin != 'legacy'
            AND r.source_revision = (SELECT revision FROM ${schemaName}.wiki_concepts WHERE id = r.source_concept_id)
            AND EXISTS (SELECT 1 FROM ${schemaName}.wiki_concepts t
              WHERE t.id = r.target_concept_id AND t.collection_id = c.collection_id
                AND t.status = 'compiled' AND t.citation_status = 'verified')
          )
          WHERE c.collection_id = $1 AND c.status = 'compiled'
            AND c.citation_status = 'verified' AND c.slug != '_index'
          GROUP BY c.id, c.concept_name
        ),
        total_edges AS (
          SELECT COUNT(*) AS cnt FROM ${schemaName}.wiki_relationships r WHERE r.collection_id = $1
            AND r.origin != 'legacy'
            AND r.source_revision = (SELECT revision FROM ${schemaName}.wiki_concepts WHERE id = r.source_concept_id)
        )
        SELECT
          (SELECT AVG(degree)::float FROM degree_stats) AS average_degree,
          (SELECT MAX(degree)::int FROM degree_stats) AS max_degree,
          (SELECT id FROM degree_stats ORDER BY degree DESC LIMIT 1) AS max_degree_concept_id,
          (SELECT concept_name FROM degree_stats ORDER BY degree DESC LIMIT 1) AS max_degree_concept_name,
          (SELECT degree FROM degree_stats ORDER BY degree DESC LIMIT 1) AS max_degree_value,
          (SELECT COUNT(*)::int FROM degree_stats WHERE degree = 0) AS isolated_count,
          (SELECT cnt::int FROM total_edges) AS total_edges
      `, [collectionId])

      const row = statsResult.rows[0]
      return {
        averageDegree: parseFloat(String(row.average_degree)) || 0,
        maxDegree: parseInt(String(row.max_degree)) || 0,
        maxDegreeConcept: {
          id: row.max_degree_concept_id || '',
          conceptName: row.max_degree_concept_name || '',
          degree: parseInt(String(row.max_degree_value)) || 0,
        },
        isolatedConceptCount: parseInt(String(row.isolated_count)) || 0,
        totalEdges: parseInt(String(row.total_edges)) || 0,
      }
    } finally {
      client.release()
    }
  }

  private visibleConcepts(collectionId: string) {
    return and(eq(wikiConcepts.collectionId, collectionId), eq(wikiConcepts.status, 'compiled'),
      eq(wikiConcepts.citationStatus, 'verified'), sql`${wikiConcepts.slug} != '_index'`)
  }

  private visibleRelationships(collectionId: string) {
    return and(eq(wikiRelationships.collectionId, collectionId), sql`${wikiRelationships.origin} != 'legacy'`,
      sql`${wikiRelationships.sourceRevision} = (SELECT revision FROM ${wikiConcepts} WHERE id = ${wikiRelationships.sourceConceptId})`)
  }
}
