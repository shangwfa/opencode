import { Hono } from 'hono'
import { databaseService } from '../services'
import { z } from 'zod'

const ListQuerySchema = z.object({
  page: z.string().optional().transform((val) => (val ? parseInt(val, 10) : 1)),
  pageSize: z.string().optional().transform((val) => (val ? parseInt(val, 10) : 20)),
  search: z.string().optional(),
  orderBy: z.enum(['createdAt', 'updatedAt', 'name']).optional(),
  orderDirection: z.enum(['ASC', 'DESC']).optional(),
  includeStats: z.string().optional().transform((val) => val === 'true')
})

export const listDatabases = new Hono().get('/', async (c) => {
  try {
    const queryParams = {
      page: c.req.query('page'),
      pageSize: c.req.query('pageSize'),
      search: c.req.query('search'),
      orderBy: c.req.query('orderBy'),
      orderDirection: c.req.query('orderDirection'),
      includeStats: c.req.query('includeStats')
    }

    const validated = ListQuerySchema.parse(queryParams)

    if (validated.page && (validated.page < 1 || isNaN(validated.page))) {
      return c.json({ code: 400, success: false, message: 'page must be >= 1', data: null }, 400)
    }

    if (validated.pageSize && (validated.pageSize < 1 || validated.pageSize > 100)) {
      return c.json(
        { code: 400, success: false, message: 'pageSize must be between 1 and 100', data: null },
        400
      )
    }

    const result = await databaseService.listDatabases({
      page: validated.page,
      pageSize: validated.pageSize,
      search: validated.search,
      orderBy: validated.orderBy,
      orderDirection: validated.orderDirection,
      includeStats: validated.includeStats
    })

    return c.json({
      code: 200,
      success: true,
      message: 'Success',
      data: result
    })
  } catch (error: any) {
    return c.json(
      {
        code: 500,
        success: false,
        message: error.message || 'Failed to list datasets',
        data: null
      },
      500
    )
  }
})
