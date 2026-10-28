import { Hono } from 'hono'
import { wikiCompilerService } from '../services/index.js'
import { WikiCompileRequestSchema } from '../types/wiki.types'

export const wikiCompile = new Hono()
  .post('/compile', async (c) => {
  try {
    const body = await c.req.json()
    const { knowledgeBaseId, documentId } = WikiCompileRequestSchema.parse(body)

    const taskId = documentId
      ? await wikiCompilerService.compileDocument(knowledgeBaseId, documentId)
      : await wikiCompilerService.compileKnowledgeBase(knowledgeBaseId)

    return c.json({
      code: 200,
      success: true,
      message: documentId ? 'Wiki single-document compile task created' : 'Wiki compile task created',
      data: {
        taskId,
        status: 'pending',
        mode: documentId ? 'document' : 'full',
        documentId: documentId ?? null,
      }
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to create wiki compile task'
    return c.json(
      { code: 400, success: false, message, data: null },
      400
    )
  }
})
  .get('/compile', async (c) => {
    try {
      const collectionId = c.req.query('collectionId')
      if (!collectionId) return c.json({ code: 400, success: false, message: 'collectionId query parameter is required', data: null }, 400)
      const page = Math.max(1, parseInt(c.req.query('page') || '1', 10) || 1)
      const pageSize = Math.min(100, Math.max(1, parseInt(c.req.query('pageSize') || '10', 10) || 10))
      const result = await wikiCompilerService.listCompileTasks(collectionId, page, pageSize)
      return c.json({ code: 200, success: true, message: 'Success', data: result })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to list compile tasks'
      return c.json({ code: 500, success: false, message, data: null }, 500)
    }
  })
