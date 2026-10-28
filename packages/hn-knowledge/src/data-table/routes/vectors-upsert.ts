import { Hono } from 'hono'
import { databaseService } from '../services'
import { UpsertVectorsRequestSchema } from '../types/database.types'

export const upsertDatabaseVectors = new Hono().post('/:id/vectors', async (c) => {
  try {
    const datasetId = c.req.param('id')
    const body = await c.req.json()
    const validated = UpsertVectorsRequestSchema.parse(body)

    if (validated.metadata.length !== validated.vectors.length) {
      return c.json(
        {
          code: 400,
          success: false,
          message: 'metadata length must match vectors length',
          data: null
        },
        400
      )
    }

    await databaseService.upsertVectors(
      datasetId,
      validated.vectors,
      validated.metadata as Array<Record<string, unknown>>,
      validated.ids
    )

    return c.json({
      code: 200,
      success: true,
      message: 'Vectors upserted successfully',
      data: null
    })
  } catch (error: any) {
    return c.json(
      {
        code: 400,
        success: false,
        message: error.message || 'Failed to upsert vectors',
        data: null
      },
      400
    )
  }
})
