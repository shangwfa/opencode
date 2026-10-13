import { Hono } from 'hono'
import { databaseService } from '../services'
import { z } from 'zod'

const GetQuerySchema = z.object({
  includeStats: z.string().optional().transform((val) => val === 'true')
})

export const getDatabase = new Hono().get('/:id', async (c) => {
  try {
    const id = c.req.param('id')
    const validated = GetQuerySchema.parse({ includeStats: c.req.query('includeStats') })
    const data = await databaseService.getDatabase(id, {
      includeStats: validated.includeStats
    })

    if (!data) {
      return c.json({ code: 404, success: false, message: 'Dataset not found', data: null }, 404)
    }

    return c.json({
      code: 200,
      success: true,
      message: 'Success',
      data
    })
  } catch (error: any) {
    return c.json(
      {
        code: 500,
        success: false,
        message: error.message || 'Failed to get dataset',
        data: null
      },
      500
    )
  }
})
