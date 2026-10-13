import { Hono } from 'hono'
import { knowledgeBaseService } from '../services'
import { z } from 'zod'

/**
 * 文档列表查询参数Schema
 */
const ListDocumentsQuerySchema = z.object({
  page: z.string().optional().transform(val => val ? parseInt(val, 10) : 1),
  pageSize: z.string().optional().transform(val => val ? parseInt(val, 10) : 20),
  search: z.string().optional(),
  // 元信息筛选（MongoDB 风格 JSON，如 {"docPath":"功能文档"}），由调用方决定是否使用
  metadata: z.string().optional(),
  orderBy: z.enum(['createdAt', 'updatedAt', 'id']).optional(),
  orderDirection: z.enum(['ASC', 'DESC']).optional()
})

export const listDocuments = new Hono().get('/:id/documents', async (c) => {
  try {
    const knowledgeBaseId = c.req.param('id')

    // 解析查询参数
    const queryParams = {
      page: c.req.query('page'),
      pageSize: c.req.query('pageSize'),
      search: c.req.query('search'),
      metadata: c.req.query('metadata'),
      orderBy: c.req.query('orderBy'),
      orderDirection: c.req.query('orderDirection')
    }

    const validated = ListDocumentsQuerySchema.parse(queryParams)

    // 元信息筛选参数解析（非法 JSON → 400）
    let metadataFilter: Record<string, any> | undefined
    if (validated.metadata && validated.metadata.trim()) {
      try {
        metadataFilter = JSON.parse(validated.metadata)
        if (!metadataFilter || typeof metadataFilter !== 'object' || Array.isArray(metadataFilter)) {
          throw new Error('metadata must be a JSON object')
        }
      } catch {
        return c.json({
          code: 400,
          success: false,
          message: 'metadata must be a valid MongoDB-style JSON object',
          data: null
        }, 400)
      }
    }

    // 参数验证
    if (validated.page && (validated.page < 1 || isNaN(validated.page))) {
      return c.json({
        code: 400,
        success: false,
        message: 'page must be >= 1',
        data: null
      }, 400)
    }

    if (validated.pageSize && (validated.pageSize < 1 || validated.pageSize > 100)) {
      return c.json({
        code: 400,
        success: false,
        message: 'pageSize must be between 1 and 100',
        data: null
      }, 400)
    }

    // 调用服务层
    const result = await knowledgeBaseService.listDocuments(knowledgeBaseId, {
      page: validated.page,
      pageSize: validated.pageSize,
      search: validated.search,
      metadataFilter,
      orderBy: validated.orderBy,
      orderDirection: validated.orderDirection
    })

    return c.json({
      code: 200,
      success: true,
      message: 'Success',
      data: result
    })
  } catch (error: any) {
    return c.json(
      {
        code: 500,
        success: false,
        message: error.message || 'Failed to list documents',
        data: null
      },
      500
    )
  }
})
