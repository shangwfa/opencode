import { Hono } from 'hono'
import { knowledgeBaseService } from '../services'

export const deleteKnowledgeBase = new Hono().delete('/:id', async (c) => {
  try {
    const id = c.req.param('id')
    await knowledgeBaseService.deleteKnowledgeBase(id)

    return c.json({
      code: 200,
      success: true,
      message: 'Knowledge base deleted successfully',
      data: null
    })
  } catch (error: any) {
    return c.json(
      {
        code: 500,
        success: false,
        message: error.message || 'Failed to delete knowledge base',
        data: null
      },
      500
    )
  }
})
