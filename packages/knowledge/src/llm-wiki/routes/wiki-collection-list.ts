import { Hono } from 'hono'
import { wikiCollectionService } from '../services/index.js'
import { z } from 'zod'

const ListWikiCollectionsQuerySchema = z.object({
  page: z.string().optional().transform((val) => (val ? parseInt(val, 10) : 1)),
  pageSize: z.string().optional().transform((val) => (val ? parseInt(val, 10) : 10)),
  knowledgeBaseId: z.string().optional()
})

export const wikiCollectionList = new Hono().get('/collections', async (c) => {
  try {
    const queryParams = {
      page: c.req.query('page'),
      pageSize: c.req.query('pageSize'),
      knowledgeBaseId: c.req.query('knowledgeBaseId')
    }

    const validated = ListWikiCollectionsQuerySchema.parse(queryParams)

    if (validated.page && (validated.page < 1 || isNaN(validated.page))) {
      return c.json(
        { code: 400, success: false, message: 'page must be >= 1', data: null },
        400
      )
    }

    if (validated.pageSize && (validated.pageSize < 1 || validated.pageSize > 100)) {
      return c.json(
        { code: 400, success: false, message: 'pageSize must be between 1 and 100', data: null },
        400
      )
    }

    const result = await wikiCollectionService.listCollections({
      page: validated.page,
      pageSize: validated.pageSize,
      knowledgeBaseId: validated.knowledgeBaseId
    })

    return c.json({
      code: 200,
      success: true,
      message: 'Success',
      data: result
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to list wiki collections'
    return c.json(
      { code: 500, success: false, message, data: null },
      500
    )
  }
})
