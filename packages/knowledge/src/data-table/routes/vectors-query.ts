import { Hono } from 'hono'
import { databaseService } from '../services'
import { QueryVectorsRequestSchema } from '../types/database.types'

export const queryDatabaseVectors = new Hono().post('/:id/vectors/query', async (c) => {
  try {
    const datasetId = c.req.param('id')
    const body = await c.req.json()
    const validated = QueryVectorsRequestSchema.parse(body)

    const pgVectorConfig: { minScore?: number; ef?: number; probes?: number } = {}
    if (validated.minScore !== undefined) pgVectorConfig.minScore = validated.minScore
    if (validated.ef !== undefined) pgVectorConfig.ef = validated.ef
    if (validated.probes !== undefined) pgVectorConfig.probes = validated.probes

    const results = await databaseService.queryVectors(
      datasetId,
      validated.queryVector,
      validated.topK ?? 10,
      validated.filter as Record<string, unknown> | undefined,
      Object.keys(pgVectorConfig).length ? pgVectorConfig : undefined
    )

    return c.json({
      code: 200,
      success: true,
      message: 'Success',
      data: results
    })
  } catch (error: any) {
    return c.json(
      {
        code: 400,
        success: false,
        message: error.message || 'Failed to query vectors',
        data: null
      },
      400
    )
  }
})
