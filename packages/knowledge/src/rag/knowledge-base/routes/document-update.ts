import { Hono } from 'hono'
import { knowledgeBaseService, documentService } from '../services'
import { UpdateDocumentRequestSchema } from '../types/knowledge-base.types'

export const updateDocument = new Hono().put('/:id/documents/:docId', async (c) => {
  try {
    const knowledgeBaseId = c.req.param('id')
    const documentId = c.req.param('docId')

    // 检查文档是否存在
    const existingDoc = await knowledgeBaseService.getDocument(documentId)
    if (!existingDoc) {
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

    const body = await c.req.json()
    const validated = UpdateDocumentRequestSchema.parse(body)

    // 确定是否需要重新处理文档
    const needsReprocessing =
      validated.content !== undefined ||
      validated.type !== undefined ||
      validated.chunkStrategy !== undefined ||
      validated.chunkConfig !== undefined

    let chunkCount = existingDoc.chunkCount || 0

    // 如果需要重新处理文档
    if (needsReprocessing && validated.content) {
      // 获取知识库配置
      const kb = await knowledgeBaseService.getKnowledgeBase(knowledgeBaseId)
      if (!kb) {
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

      try {
        await knowledgeBaseService.updateDocumentStatus(documentId, 'processing')

        // 先更新向量，成功后再提交 documents 内容和元数据，避免内容新、向量旧的不一致。
        const result = await documentService.updateDocument(
          knowledgeBaseId,
          documentId,
          validated.content,
          validated.type || existingDoc.type,
          validated.chunkStrategy || existingDoc.chunkStrategy,
          validated.chunkConfig || existingDoc.chunkConfig,
          validated.metadata || existingDoc.metadata, // 传递 metadata
          kb.embeddingModel // 传递知识库的嵌入模型配置
        )

        chunkCount = result.chunkCount

        await knowledgeBaseService.updateDocument(
          documentId,
          validated.content,
          validated.type,
          validated.chunkStrategy,
          validated.chunkConfig,
          validated.metadata
        )
        await knowledgeBaseService.updateDocumentChunkCount(documentId, chunkCount)
        await knowledgeBaseService.updateDocumentStatus(documentId, 'completed')
      } catch (processError: any) {
        await knowledgeBaseService.updateDocumentStatus(documentId, 'failed', processError.message)
        throw processError
      }
    } else {
      const updatedDoc = await knowledgeBaseService.updateDocument(
        documentId,
        validated.content,
        validated.type,
        validated.chunkStrategy,
        validated.chunkConfig,
        validated.metadata
      )
      chunkCount = updatedDoc?.chunkCount || chunkCount
    }

    // 获取最终文档
    const finalDoc = await knowledgeBaseService.getDocument(documentId)

    return c.json({
      code: 200,
      success: true,
      message: 'Document updated successfully',
      data: {
        ...finalDoc,
        chunkCount
      }
    })
  } catch (error: any) {
    return c.json(
      {
        code: 400,
        success: false,
        message: error.message || 'Failed to update document',
        data: null
      },
      400
    )
  }
})
