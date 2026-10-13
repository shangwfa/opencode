import { Hono } from 'hono'
import { knowledgeBaseService } from '../services'
import { CreateKnowledgeBaseRequestSchema } from '../types/knowledge-base.types'

export const createKnowledgeBase = new Hono().post('/', async (c) => {
  try {
    const body = await c.req.json()
    const validated = CreateKnowledgeBaseRequestSchema.parse(body)

    const kb = await knowledgeBaseService.createKnowledgeBase(validated)

    return c.json({
      code: 200,
      success: true,
      message: 'Knowledge base created successfully',
      data: kb
    })
  } catch (error: any) {
    return c.json(
      {
        code: 400,
        success: false,
        message: error.message || 'Failed to create knowledge base',
        data: null
      },
      400
    )
  }
})

