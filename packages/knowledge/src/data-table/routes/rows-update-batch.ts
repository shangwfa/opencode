import { Hono } from 'hono'
import { databaseService } from '../services'
import { BatchRowsUpdateRequestSchema } from '../types/database.types'

/**
 * PATCH /database/:id/rows/batch
 * body: { items: [{ id, patch }, ...] }，同一事务更新多行；有字段变更的行在提交后按批重新向量化。
 */
export const updateDatabaseRowsBatch = new Hono().patch('/:id/rows/batch', async (c) => {
  try {
    const datasetId = c.req.param('id')
    const body = await c.req.json()
    const validated = BatchRowsUpdateRequestSchema.parse(body)
    const data = await databaseService.updateRowsBatch(datasetId, validated)

    return c.json({
      code: 200,
      success: true,
      message: 'Rows updated successfully',
      data
    })
  } catch (error: any) {
    const status = error.message?.includes('not found') ? 404 : 400
    return c.json(
      {
        code: status,
        success: false,
        message: error.message || 'Failed to batch update rows',
        data: null
      },
      status
    )
  }
})
