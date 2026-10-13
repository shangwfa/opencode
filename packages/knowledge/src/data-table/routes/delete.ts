import { Hono } from 'hono'
import { databaseService } from '../services'

export const deleteDatabase = new Hono().delete('/:id', async (c) => {
  try {
    const id = c.req.param('id')
    await databaseService.deleteDatabase(id)

    return c.json({
      code: 200,
      success: true,
      message: 'Dataset deleted successfully',
      data: null
    })
  } catch (error: any) {
    const status = error.message?.includes('not found') ? 404 : 500
    return c.json(
      {
        code: status,
        success: false,
        message: error.message || 'Failed to delete dataset',
        data: null
      },
      status
    )
  }
})
