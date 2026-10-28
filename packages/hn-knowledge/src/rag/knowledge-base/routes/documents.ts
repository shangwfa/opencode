import { Hono } from 'hono'
import { knowledgeBaseService, documentService } from '../services'
import { AddDocumentRequestSchema } from '../types/knowledge-base.types'
import { FileParser } from '../../../utils/file-parser'

export const addDocument = new Hono().post('/:id/documents', async (c) => {
  try {
    const knowledgeBaseId = c.req.param('id')

    // 检查知识库是否存在
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

    let content: string
    let type: 'text' | 'markdown' | 'html' | 'tiptap' = 'text'
    let chunkStrategy: string | undefined
    let chunkConfig: any
    let metadata: Record<string, any> | undefined
    let documentId: string | undefined

    // 检查是否是文件上传（multipart/form-data）
    const contentType = c.req.header('content-type') || ''
    if (contentType.includes('multipart/form-data')) {
      const formData = await c.req.formData()
      const file = formData.get('file') as File | null

      if (file) {
        // 处理文件上传
        const buffer = Buffer.from(await file.arrayBuffer())
        const parsed = await FileParser.parseFile(buffer, file.name)
        content = parsed.content
        type = parsed.type
      } else {
        return c.json(
          {
            code: 400,
            success: false,
            message: 'File is required for file upload',
            data: null
          },
          400
        )
      }

      // 从表单数据获取其他参数
      const idStr = formData.get('id') as string | null
      const strategyStr = formData.get('chunkStrategy') as string | null
      const configStr = formData.get('chunkConfig') as string | null
      const metadataStr = formData.get('metadata') as string | null

      documentId = idStr || undefined
      chunkStrategy = strategyStr || undefined
      chunkConfig = configStr ? JSON.parse(configStr) : undefined
      metadata = metadataStr ? JSON.parse(metadataStr) : undefined
    } else {
      // JSON 请求体
      const body = await c.req.json()
      const validated = AddDocumentRequestSchema.parse(body)

      // 处理 URL 或内容
      if (validated.url) {
        const parsed = await FileParser.parseURL(validated.url)
        content = parsed.content
        type = parsed.type
      } else if (validated.content) {
        content = validated.content
        type = validated.type || 'text'
      } else {
        return c.json(
          {
            code: 400,
            success: false,
            message: 'Either content or url must be provided',
            data: null
          },
          400
        )
      }

      documentId = validated.id
      chunkStrategy = validated.chunkStrategy
      chunkConfig = validated.chunkConfig
      metadata = validated.metadata
    }

    // 创建文档记录
    const doc = await knowledgeBaseService.createDocument(
      knowledgeBaseId,
      content,
      type,
      chunkStrategy as any,
      chunkConfig,
      metadata,
      documentId
    )

    let chunkCount = 0
    try {
      // 处理文档：分块、生成嵌入、存储向量
      const result = await documentService.processDocument(
        knowledgeBaseId,
        content,
        doc.id,
        type,
        (chunkStrategy as any) || kb.defaultChunkStrategy,
        chunkConfig || kb.defaultChunkConfig,
        metadata, // 传递文档的 metadata
        kb.embeddingModel // 传递知识库的嵌入模型配置
      )
      chunkCount = result.chunkCount

      // 更新文档的块数量和完成状态
      await knowledgeBaseService.updateDocumentChunkCount(doc.id, chunkCount)
      await knowledgeBaseService.updateDocumentStatus(doc.id, 'completed')
    } catch (processError: any) {
      await knowledgeBaseService.updateDocumentStatus(doc.id, 'failed', processError.message)
      throw processError
    }

    // 获取更新后的文档
    const updatedDoc = await knowledgeBaseService.getDocument(doc.id)

    // 确保返回的响应中始终包含文档ID
    // 如果 getDocument 返回 null，使用创建的 doc 对象
    const responseDoc = updatedDoc || doc

    return c.json({
      code: 200,
      success: true,
      message: 'Document added successfully',
      data: {
        ...responseDoc,
        chunkCount
      }
    })
  } catch (error: any) {
    return c.json(
      {
        code: 400,
        success: false,
        message: error.message || 'Failed to add document',
        data: null
      },
      400
    )
  }
})
