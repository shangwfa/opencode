import { Hono } from 'hono'
import { vectorService, knowledgeBaseService } from '../services'

export const listAllChunks = new Hono().get('/:id/chunks', async (c) => {
  try {
    const knowledgeBaseId = c.req.param('id')

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

    // 获取查询参数
    const limit = c.req.query('limit') ? parseInt(c.req.query('limit') as string, 10) : undefined
    const offset = c.req.query('offset') ? parseInt(c.req.query('offset') as string, 10) : undefined
    const orderBy = (c.req.query('orderBy') as 'chunkIndex' | 'documentId' | undefined) || 'chunkIndex'
    const orderDirection = (c.req.query('orderDirection') as 'ASC' | 'DESC' | undefined) || 'ASC'

    // 验证参数
    if (limit !== undefined && (isNaN(limit) || limit < 1 || limit > 10000)) {
      console.warn(`[ChunkAPI] Invalid limit parameter: ${limit}`)
      return c.json(
        {
          code: 400,
          success: false,
          message: 'limit must be between 1 and 10000',
          data: null
        },
        400
      )
    }

    if (offset !== undefined && (isNaN(offset) || offset < 0)) {
      console.warn(`[ChunkAPI] Invalid offset parameter: ${offset}`)
      return c.json(
        {
          code: 400,
          success: false,
          message: 'offset must be >= 0',
          data: null
        },
        400
      )
    }

    // 获取所有chunks
    const result = await vectorService.getAllChunksByKnowledgeBaseId(knowledgeBaseId, {
      limit,
      offset,
      orderBy,
      orderDirection
    })

    console.log(`[ChunkAPI] Listed ${result.chunks.length} chunks (total: ${result.total}) for knowledge base ${knowledgeBaseId}`)
    return c.json({
      code: 200,
      success: true,
      message: 'Success',
      data: result
    })
  } catch (error: any) {
    console.error(`[ChunkAPI] Failed to list all chunks:`, {
      knowledgeBaseId: c.req.param('id'),
      error: error.message,
      stack: error.stack
    })
    return c.json(
      {
        code: 500,
        success: false,
        message: error.message || 'Failed to list all chunks',
        data: null
      },
      500
    )
  }
})

