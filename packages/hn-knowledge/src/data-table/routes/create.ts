import { Hono } from 'hono'
import { databaseService } from '../services'
import { CreateDatabaseRequestSchema } from '../types/database.types'

export const createDatabase = new Hono().post('/', async (c) => {
  try {
    const body = await c.req.json()
    const validated = CreateDatabaseRequestSchema.parse(body)
    const data = await databaseService.createDatabase(validated)

    return c.json({
      code: 200,
      success: true,
      message: 'Dataset created successfully',
      data
    })
  } catch (error: any) {
    const status = error.code === 'INDEX_NAME_CONFLICT' ? 409 : 400
    return c.json(
      {
        code: status,
        success: false,
        message: error.message || 'Failed to create dataset',
        data: null
      },
      status
    )
  }
})
