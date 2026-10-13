import { Hono } from 'hono'
import { wikiLintService } from '../services/index.js'

export const wikiLintRun = new Hono().post('/collections/:collectionId/lint', async (c) => {
  try {
    const collectionId = c.req.param('collectionId')
    const body = await c.req.json().catch(() => ({}))
    const includeSemantic = body.includeSemantic === true

    const results = await wikiLintService.runLint(collectionId, includeSemantic)

    return c.json({
      code: 200,
      success: true,
      message: 'Lint completed',
      data: { results, total: results.length },
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Lint failed'
    return c.json(
      { code: 500, success: false, message, data: null },
      500,
    )
  }
})

export const wikiLintGet = new Hono().get('/collections/:collectionId/lint', async (c) => {
  try {
    const collectionId = c.req.param('collectionId')
    const results = await wikiLintService.runStructuralLint(collectionId)

    return c.json({
      code: 200,
      success: true,
      message: 'Success',
      data: { results, total: results.length },
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Lint failed'
    return c.json(
      { code: 500, success: false, message, data: null },
      500,
    )
  }
})
