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
    return c.json(
      {
        code: 400,
        success: false,
        message: error.message || 'Failed to create dataset',
        data: null
      },
      400
    )
  }
})
