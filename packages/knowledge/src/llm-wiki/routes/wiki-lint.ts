import { Hono } from 'hono'
import { wikiLintService } from '../services/index.js'

export const wikiLintRun = new Hono().post('/collections/:collectionId/lint', async (c) => {
  try {
    const collectionId = c.req.param('collectionId')
    const body = await c.req.json().catch(() => ({}))
    const includeSemantic = body.includeSemantic === true

    if (includeSemantic) {
      // 手动全量语义审查是页面级逐页调用：大库同步 HTTP 必超时，限 50 页；更大规模走编译自动增量巡检（autoSemanticLint）。
      const { pool, schemaName } = await import('../db/index.js')
      const count = await pool.query(`SELECT count(*)::int AS n FROM ${schemaName}.wiki_concepts
        WHERE collection_id=$1 AND status IN ('compiled','needs_review')`, [collectionId])
      if ((count.rows[0]?.n ?? 0) > 50) {
        return c.json({ code: 400, success: false,
          message: `Manual full semantic lint limited to 50 pages (got ${count.rows[0].n}); enable schema autoSemanticLint for incremental review per compile`,
          data: null }, 400)
      }
    }

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
