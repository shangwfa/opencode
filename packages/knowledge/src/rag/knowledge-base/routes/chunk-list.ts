import { Hono } from 'hono'
import { vectorService, knowledgeBaseService } from '../services'

export const listChunks = new Hono().get('/:id/documents/:docId/chunks', async (c) => {
  try {
    const knowledgeBaseId = c.req.param('id')
    const docId = c.req.param('docId')

    // 验证知识库是否存在
    const kb = await knowledgeBaseService.getKnowledgeBase(knowledgeBaseId)
    if (!kb) {
      console.warn(`[ChunkAPI] Knowledge base not found: ${knowledgeBaseId}`)
      return c.json(
        {
          code: 404,
          success: false,
          message: 'Knowledge base not found',
          data: null
        },
        404
      )
    }

    // 验证文档是否存在
    const doc = await knowledgeBaseService.getDocument(docId)
    if (!doc) {
      console.warn(`[ChunkAPI] Document not found: ${docId}`)
      return c.json(
        {
          code: 404,
          success: false,
          message: 'Document not found',
          data: null
        },
        404
      )
    }

    // 验证文档是否属于该知识库
    if (doc.knowledgeBaseId !== knowledgeBaseId) {
      console.warn(`[ChunkAPI] Document ${docId} does not belong to knowledge base ${knowledgeBaseId}`)
      return c.json(
        {
          code: 400,
          success: false,
          message: 'Document does not belong to this knowledge base',
          data: null
        },
        400
      )
    }

    // 获取所有chunks
    const chunks = await vectorService.getChunksByDocumentId(knowledgeBaseId, docId)

    console.log(`[ChunkAPI] Listed ${chunks.length} chunks for document ${docId}`)
    return c.json({
      code: 200,
      success: true,
      message: 'Success',
      data: {
        documentId: docId,
        chunkCount: chunks.length,
        chunks
      }
    })
  } catch (error: any) {
    console.error(`[ChunkAPI] Failed to list chunks:`, {
      knowledgeBaseId: c.req.param('id'),
      documentId: c.req.param('docId'),
      error: error.message,
      stack: error.stack
    })
    return c.json(
      {
        code: 500,
        success: false,
        message: error.message || 'Failed to list chunks',
        data: null
      },
      500
    )
  }
})

