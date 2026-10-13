import { Hono } from 'hono'
import { databaseService } from '../services'
import { UpdateDatabaseRequestSchema } from '../types/database.types'

/** PATCH：更新 schema；若删了旧列且向量索引已就绪，则对动态表全量重新向量化。 */
export const updateDatabase = new Hono().patch('/:id', async (c) => {
  try {
    const id = c.req.param('id')
    const body = await c.req.json()
    const validated = UpdateDatabaseRequestSchema.parse(body)
    const data = await databaseService.updateDatabase(id, validated)

    return c.json({
      code: 200,
      success: true,
      message: 'Dataset updated successfully',
      data
    })
  } catch (error: any) {
    const status = error.message?.includes('not found') ? 404 : 400
    return c.json(
      {
        code: status,
        success: false,
        message: error.message || 'Failed to update dataset',
        data: null
      },
      status
    )
  }
})
