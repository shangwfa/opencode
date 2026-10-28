import { Hono } from 'hono'
import { wikiCollectionService } from '../services/index.js'

export const wikiCollectionDelete = new Hono().delete('/collections/:id', async (c) => {
  try {
    const collectionId = c.req.param('id')

    if (!collectionId) {
      return c.json(
        { code: 400, success: false, message: 'Collection id is required', data: null },
        400
      )
    }

    const collection = await wikiCollectionService.getCollection(collectionId)

    if (!collection) {
      return c.json(
        { code: 404, success: false, message: `Wiki collection ${collectionId} not found`, data: null },
        404
      )
    }

    await wikiCollectionService.deleteCollection(collectionId)

    return c.json({
      code: 200,
      success: true,
      message: 'Wiki collection deleted successfully',
      data: null
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to delete wiki collection'
    return c.json(
      { code: 500, success: false, message, data: null },
      500
    )
  }
})
