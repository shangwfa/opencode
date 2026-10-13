import { Hono } from 'hono'
import { wikiCollectionService } from '../services/index.js'
import { CreateWikiCollectionRequestSchema } from '../types/wiki.types'

export const wikiCollectionCreate = new Hono().post('/collections', async (c) => {
  try {
    const body = await c.req.json()
    const validated = CreateWikiCollectionRequestSchema.parse(body)

    const collection = await wikiCollectionService.createCollection(
      validated.knowledgeBaseId,
      validated.name
    )

    return c.json({
      code: 200,
      success: true,
      message: 'Wiki collection created successfully',
      data: collection
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to create wiki collection'
    return c.json(
      { code: 400, success: false, message, data: null },
      400
    )
  }
})
