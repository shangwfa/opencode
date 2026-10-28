import { Hono } from 'hono'
import { knowledgeBaseService, vectorService } from '../services'

export const deleteDocument = new Hono().delete('/:id/documents/:docId', async (c) => {
  try {
    const knowledgeBaseId = c.req.param('id')
    const documentId = c.req.param('docId')

    // 检查文档是否存在
    const doc = await knowledgeBaseService.getDocument(documentId)
    if (!doc) {
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

    // 删除向量数据
    await vectorService.deleteByDocumentId(knowledgeBaseId, documentId)

    // 删除文档记录
    await knowledgeBaseService.deleteDocument(documentId)

    return c.json({
      code: 200,
      success: true,
      message: 'Document deleted successfully',
      data: null
    })
  } catch (error: any) {
    return c.json(
      {
        code: 500,
        success: false,
        message: error.message || 'Failed to delete document',
        data: null
      },
      500
    )
  }
})
