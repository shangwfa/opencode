import { Hono } from 'hono'
import { wikiSearchService, wikiRetrievalService } from '../services/index.js'
import { WikiSearchRequestSchema } from '../types/wiki.types'

export const wikiSearch = new Hono().post('/search', async (c) => {
  try {
    const body = await c.req.json()
    const validated = WikiSearchRequestSchema.parse(body)

    if (validated.budgetTokens) {
      const context = await wikiRetrievalService.retrieve(
        validated.knowledgeBaseId,
        validated.query,
        { budgetTokens: validated.budgetTokens, topK: validated.topK,
          includeRelated: validated.includeRelated, depth: validated.depth }
      )

      return c.json({
        code: 200,
        success: true,
        message: 'Retrieval completed',
        data: context,
      })
    }

    const result = await wikiSearchService.search(validated.knowledgeBaseId, validated.query, {
      topK: validated.topK,
      includeRelated: validated.includeRelated,
      depth: validated.depth,
    })

    return c.json({
      code: 200,
      success: true,
      message: 'Search completed',
      data: result,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Wiki search failed'
    return c.json(
      { code: 400, success: false, message, data: null },
      400,
    )
  }
})
