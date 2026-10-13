import { Hono } from 'hono'
import { knowledgeBaseService } from '../services'

export const getDocument = new Hono().get('/:id/documents/:docId', async (c) => {
  try {
    const docId = c.req.param('docId')
    const doc = await knowledgeBaseService.getDocument(docId)

    if (!doc) {
      return c.json(
        {
          code: 404,
          success: false,
          message: 'Document not found',
          data: null
        },
        404
      )
    }

    return c.json({
      code: 200,
      success: true,
      message: 'Success',
      data: doc
    })
  } catch (error: any) {
    return c.json(
      {
        code: 500,
        success: false,
        message: error.message || 'Failed to get document',
        data: null
      },
      500
    )
  }
})
