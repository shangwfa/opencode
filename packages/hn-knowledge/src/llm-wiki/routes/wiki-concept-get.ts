import { Hono } from 'hono'
import { wikiSearchService, wikiCollectionService } from '../services/index.js'
import { z } from 'zod'

const ConceptDetailQuerySchema = z.object({
  conceptId: z.string().optional(),
  slug: z.string().optional(),
}).refine(data => data.conceptId || data.slug, {
  message: 'conceptId 或 slug 必须提供其一',
})

export const wikiConceptGet = new Hono().get('/collections/:collectionId/concepts', async (c) => {
  try {
    const collectionId = c.req.param('collectionId')
    const conceptId = c.req.query('conceptId')
    const slug = c.req.query('slug')

    if (!conceptId && !slug) {
      return c.json(
        { code: 400, success: false, message: 'conceptId or slug query parameter required', data: null },
        400,
      )
    }

    let concept = null
    if (slug) {
      concept = await wikiSearchService.getConceptBySlug(collectionId, slug)
    } else if (conceptId) {
      concept = await wikiSearchService.getConceptDetail(collectionId, conceptId)
    }

    if (!concept) {
      return c.json(
        { code: 404, success: false, message: 'Concept not found', data: null },
        404,
      )
    }

    const [relatedConcepts, sourceDocumentIds] = await Promise.all([
      wikiSearchService.getRelatedConcepts(concept.id, 1),
      wikiSearchService.getConceptSources(concept.id),
    ])

    return c.json({
      code: 200,
      success: true,
      message: 'Success',
      data: {
        concept,
        relatedConcepts: relatedConcepts.map(c => ({
          id: c.id,
          conceptName: c.conceptName,
          slug: c.slug,
          summary: c.summary,
        })),
        sourceDocumentIds,
      },
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to get concept detail'
    return c.json(
      { code: 500, success: false, message, data: null },
      500,
    )
  }
})
