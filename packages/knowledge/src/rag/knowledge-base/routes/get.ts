import { Hono } from 'hono'
import { knowledgeBaseService } from '../services'

export const getKnowledgeBase = new Hono().get('/:id', async (c) => {
  try {
    const id = c.req.param('id')
    const kb = await knowledgeBaseService.getKnowledgeBase(id)

    if (!kb) {
      return c.json(
        {
          code: 404,
          success: false,
          message: 'Knowledge base not found',
          data: null
        },
        404
      )
    }

    return c.json({
      code: 200,
      success: true,
      message: 'Success',
      data: kb
    })
  } catch (error: any) {
    return c.json(
      {
        code: 500,
        success: false,
        message: error.message || 'Failed to get knowledge base',
        data: null
      },
      500
    )
  }
})
