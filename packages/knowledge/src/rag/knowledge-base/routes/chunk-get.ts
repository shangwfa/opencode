import { Hono } from 'hono'
import { vectorService, knowledgeBaseService } from '../services'

export const getChunk = new Hono().get('/:id/documents/:docId/chunks/:chunkIndex', async (c) => {
  try {
    const knowledgeBaseId = c.req.param('id')
    const docId = c.req.param('docId')
    const chunkIndexParam = c.req.param('chunkIndex')

    // 解析chunkIndex
    const chunkIndex = parseInt(chunkIndexParam, 10)
    if (isNaN(chunkIndex) || chunkIndex < 0) {
      console.warn(`[ChunkAPI] Invalid chunk index requested: ${chunkIndexParam}`)
      return c.json(
        {
          code: 400,
          success: false,
          message: 'Invalid chunk index',
          data: null
        },
        400
      )
    }

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

    // 获取指定的chunk
    const chunk = await vectorService.getChunkByIndex(knowledgeBaseId, docId, chunkIndex)

    if (!chunk) {
      console.log(`[ChunkAPI] Chunk not found: document=${docId}, index=${chunkIndex}`)
      return c.json(
        {
          code: 404,
          success: false,
          message: 'Chunk not found',
          data: null
        },
        404
      )
    }

    console.log(`[ChunkAPI] Successfully retrieved chunk: document=${docId}, index=${chunkIndex}`)
    return c.json({
      code: 200,
      success: true,
      message: 'Success',
      data: chunk
    })
  } catch (error: any) {
    console.error(`[ChunkAPI] Failed to get chunk:`, {
      knowledgeBaseId: c.req.param('id'),
      documentId: c.req.param('docId'),
      chunkIndex: c.req.param('chunkIndex'),
      error: error.message,
      stack: error.stack
    })
    return c.json(
      {
        code: 500,
        success: false,
        message: error.message || 'Failed to get chunk',
        data: null
      },
      500
    )
  }
})

