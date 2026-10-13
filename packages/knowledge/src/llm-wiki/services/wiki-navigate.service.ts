import { db, wikiConcepts, wikiRelationships, pool, schemaName } from '../db/index.js'
import { eq, desc, sql } from 'drizzle-orm'
import { WikiCollectionService } from './wiki-collection.service.js'
import type { WikiNavigateOverview, WikiGraphStats } from '../types/wiki.types.js'

export class WikiNavigateService {
  constructor(private wikiCollectionService: WikiCollectionService) {}

  async getOverview(collectionId: string): Promise<WikiNavigateOverview> {
    const conceptCountResult = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(wikiConcepts)
      .where(eq(wikiConcepts.collectionId, collectionId))

    const conceptCount = conceptCountResult[0]?.count ?? 0

    const relationshipCountResult = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(wikiRelationships)
      .where(eq(wikiRelationships.collectionId, collectionId))

    const relationshipCount = relationshipCountResult[0]?.count ?? 0

    const tagDistribution = await db
      .select({
        tag: sql<string>`jsonb_array_elements_text(tags)`,
        count: sql<number>`count(*)::int`,
      })
      .from(wikiConcepts)
      .where(eq(wikiConcepts.collectionId, collectionId))
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
      .where(eq(wikiConcepts.collectionId, collectionId))
      .orderBy(desc(wikiConcepts.updatedAt))
      .limit(10)

    const topConcepts = await db
      .select({
        id: wikiConcepts.id,
        conceptName: wikiConcepts.conceptName,
        occurrenceCount: wikiConcepts.occurrenceCount,
      })
      .from(wikiConcepts)
      .where(eq(wikiConcepts.collectionId, collectionId))
      .orderBy(desc(wikiConcepts.occurrenceCount))
      .limit(10)

    const typeDistribution = await db
      .select({
        type: wikiRelationships.relationshipType,
        count: sql<number>`count(*)::int`,
      })
      .from(wikiRelationships)
      .where(eq(wikiRelationships.collectionId, collectionId))
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
        sql`${wikiConcepts.collectionId} = ${collectionId} AND ${wikiConcepts.tags} @> ${JSON.stringify([tag])}::jsonb`
      )
      .orderBy(desc(wikiConcepts.occurrenceCount))
  }

  async getConceptsByPage(collectionId: string, page: number = 1, pageSize: number = 20) {
    const offset = (page - 1) * pageSize

    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(wikiConcepts)
      .where(eq(wikiConcepts.collectionId, collectionId))

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
      .where(eq(wikiConcepts.collectionId, collectionId))
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
            r.source_concept_id = c.id OR r.target_concept_id = c.id
          )
          WHERE c.collection_id = $1 AND c.status != 'failed'
          GROUP BY c.id, c.concept_name
        ),
        total_edges AS (
          SELECT COUNT(*) AS cnt FROM ${schemaName}.wiki_relationships WHERE collection_id = $1
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
}
