import { Hono } from 'hono'
import { databaseService } from '../services'

export const getDatabaseRow = new Hono().get('/:id/rows/:rowId', async (c) => {
  try {
    const datasetId = c.req.param('id')
    const rowId = c.req.param('rowId')
    const data = await databaseService.getRow(datasetId, rowId)

    if (!data) {
      return c.json({ code: 404, success: false, message: 'Row not found', data: null }, 404)
    }

    return c.json({
      code: 200,
      success: true,
      message: 'Success',
      data
    })
  } catch (error: any) {
    const status = error.message?.includes('not found') ? 404 : 500
    return c.json(
      {
        code: status,
        success: false,
        message: error.message || 'Failed to get row',
        data: null
      },
      status
    )
  }
})
