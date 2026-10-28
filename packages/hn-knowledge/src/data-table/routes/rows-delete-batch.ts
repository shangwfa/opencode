import { Hono } from 'hono'
import { databaseService } from '../services'
import { BatchRowsDeleteRequestSchema } from '../types/database.types'

/**
 * DELETE /database/:id/rows/batch
 * body: { ids: string[] }，先删向量再删动态表行；要求每个 id 均存在（重复 id 会去重后校验）。
 */
export const deleteDatabaseRowsBatch = new Hono().delete('/:id/rows/batch', async (c) => {
  try {
    const datasetId = c.req.param('id')
    const body = await c.req.json()
    const validated = BatchRowsDeleteRequestSchema.parse(body)
    const data = await databaseService.deleteRowsBatch(datasetId, validated)

    return c.json({
      code: 200,
      success: true,
      message: 'Rows deleted successfully',
      data
    })
  } catch (error: any) {
    const status = error.message?.includes('not found') ? 404 : 400
    return c.json(
      {
        code: status,
        success: false,
        message: error.message || 'Failed to batch delete rows',
        data: null
      },
      status
    )
  }
})
