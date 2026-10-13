import { Hono } from 'hono'
import { databaseService } from '../services'
import { z } from 'zod'

const RESERVED_QUERY_KEYS = new Set(['page', 'pageSize', 'filter'])

const ListQuerySchema = z.object({
  page: z.string().optional().transform((val) => (val ? parseInt(val, 10) : 1)),
  pageSize: z.string().optional().transform((val) => (val ? parseInt(val, 10) : 20)),
  filter: z.record(z.string(), z.unknown()).optional()
})

function parseFilterQuery(url: string): Record<string, unknown> | undefined {
  const { searchParams } = new URL(url)
  const rawFilter = searchParams.get('filter')
  const filter: Record<string, unknown> = {}

  if (rawFilter) {
    let parsed: unknown
    try {
      parsed = JSON.parse(rawFilter)
    } catch {
      throw new Error('filter must be a valid JSON object')
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('filter must be a JSON object')
    }
    Object.assign(filter, parsed as Record<string, unknown>)
  }

  for (const [key, value] of searchParams.entries()) {
    if (RESERVED_QUERY_KEYS.has(key)) continue
    if (!key.trim()) continue
    filter[key] = value
  }

  return Object.keys(filter).length > 0 ? filter : undefined
}

export const listDatabaseRows = new Hono().get('/:id/rows', async (c) => {
  try {
    const datasetId = c.req.param('id')
    const validated = ListQuerySchema.parse({
      page: c.req.query('page'),
      pageSize: c.req.query('pageSize'),
      filter: parseFilterQuery(c.req.url)
    })

    if (validated.page && validated.page < 1) {
      return c.json({ code: 400, success: false, message: 'page must be >= 1', data: null }, 400)
    }
    if (validated.pageSize && (validated.pageSize < 1 || validated.pageSize > 200)) {
      return c.json(
        { code: 400, success: false, message: 'pageSize must be between 1 and 200', data: null },
        400
      )
    }

    const data = await databaseService.listRows(datasetId, {
      page: validated.page,
      pageSize: validated.pageSize,
      filter: validated.filter
    })

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
        message: error.message || 'Failed to list rows',
        data: null
      },
      status
    )
  }
})
