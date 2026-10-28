import { Hono } from 'hono'
import { databaseService } from '../services'
import { BatchRowsMetadataRequestSchema } from '../types/database.types'

/**
 * 请求体：{ "rows": [ { "a":"...", "b":"..." }, ... ] }
 * 每条写入动态表一行（字段须与创建时的 columns 一致）；向量化文本为列定义顺序下字段值拼接，再写入 kb_* 表。
 */
export const createDatabaseRow = new Hono().post('/:id/rows', async (c) => {
  try {
    const datasetId = c.req.param('id')
    const body = await c.req.json()
    const validated = BatchRowsMetadataRequestSchema.parse(body)

    const data = await databaseService.insertRowsFromMetadataBatch(datasetId, validated.rows)

    return c.json({
      code: 200,
      success: true,
      message: 'Rows created and vectorized successfully',
      data
    })
  } catch (error: any) {
    return c.json(
      {
        code: 400,
        success: false,
        message: error.message || 'Failed to create rows',
        data: null
      },
      400
    )
  }
})
