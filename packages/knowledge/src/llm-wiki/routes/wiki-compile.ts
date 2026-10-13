import { Hono } from 'hono'
import { wikiCompilerService } from '../services/index.js'
import { WikiCompileRequestSchema } from '../types/wiki.types'

export const wikiCompile = new Hono().post('/compile', async (c) => {
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
        status: 'running',
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
