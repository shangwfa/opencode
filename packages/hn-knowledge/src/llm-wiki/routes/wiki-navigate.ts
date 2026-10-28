import { Hono } from 'hono'
import { wikiNavigateService } from '../services/index.js'

export const wikiNavigate = new Hono().get('/collections/:collectionId/navigate', async (c) => {
  try {
    const collectionId = c.req.param('collectionId')
    const overview = await wikiNavigateService.getOverview(collectionId)

    return c.json({
      code: 200,
      success: true,
      message: 'Success',
      data: overview,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to get navigation overview'
    return c.json(
      { code: 500, success: false, message, data: null },
      500,
    )
  }
})

export const wikiNavigateConcepts = new Hono().get('/collections/:collectionId/navigate/concepts', async (c) => {
  try {
    const collectionId = c.req.param('collectionId')
    const tag = c.req.query('tag')
    const page = parseInt(c.req.query('page') || '1', 10)
    const pageSize = parseInt(c.req.query('pageSize') || '20', 10)

    if (tag) {
      const concepts = await wikiNavigateService.getConceptsByTag(collectionId, tag)
      return c.json({
        code: 200,
        success: true,
        message: 'Success',
        data: { concepts, page: 1, pageSize: concepts.length, total: concepts.length },
      })
    }

    const result = await wikiNavigateService.getConceptsByPage(collectionId, page, pageSize)
    return c.json({
      code: 200,
      success: true,
      message: 'Success',
      data: { concepts: result.concepts, page, pageSize, total: result.total },
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to list concepts'
    return c.json(
      { code: 500, success: false, message, data: null },
      500,
    )
  }
})

export const wikiNavigateGraphStats = new Hono().get('/collections/:collectionId/navigate/graph-stats', async (c) => {
  try {
    const collectionId = c.req.param('collectionId')
    const stats = await wikiNavigateService.getGraphStats(collectionId)

    return c.json({
      code: 200,
      success: true,
      message: 'Success',
      data: stats,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to get graph stats'
    return c.json(
      { code: 500, success: false, message, data: null },
      500,
    )
  }
})
