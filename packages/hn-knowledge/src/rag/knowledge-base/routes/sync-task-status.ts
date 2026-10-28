import { Hono } from 'hono'
import { syncTaskService, documentSyncService } from '../services'

/**
 * 获取同步任务状态
 * GET /knowledge-base/sync-task/:taskId
 */
export const getSyncTaskStatus = new Hono().get('/sync-task/:taskId', async (c) => {
  try {
    const taskId = c.req.param('taskId')

    if (!taskId) {
      return c.json(
        {
          code: 400,
          success: false,
          message: 'Task ID is required',
          data: null
        },
        400
      )
    }

    const task = await syncTaskService.getTaskStatus(taskId)

    if (!task) {
      return c.json(
        {
          code: 404,
          success: false,
          message: 'Task not found',
          data: null
        },
        404
      )
    }

    return c.json({
      code: 200,
      success: true,
      message: 'Task status retrieved successfully',
      data: task
    })
  } catch (error: any) {
    return c.json(
      {
        code: 500,
        success: false,
        message: error.message || 'Failed to get task status',
        data: null
      },
      500
    )
  }
})

/**
 * 重试任务中的所有失败文档
 * POST /knowledge-base/sync-task/:taskId/retry-failed
 */
export const retryFailedDocuments = new Hono().post('/sync-task/:taskId/retry-failed', async (c) => {
  try {
    const taskId = c.req.param('taskId')

    if (!taskId) {
      return c.json(
        {
          code: 400,
          success: false,
          message: 'Task ID is required',
          data: null
        },
        400
      )
    }

    // 获取任务状态
    const task = await syncTaskService.getTaskStatus(taskId)
    if (!task) {
      return c.json(
        {
          code: 404,
          success: false,
          message: 'Task not found',
          data: null
        },
        404
      )
    }

    // 检查是否有可重试的失败文档
    const retryableDocs = task.failedDocuments.filter((doc) => doc.canRetry !== false)
    if (retryableDocs.length === 0) {
      return c.json({
        code: 200,
        success: true,
        message: 'No retryable failed documents',
        data: {
          taskId,
          retryableCount: 0
        }
      })
    }

    // 获取知识库ID和配置
    const knowledgeBaseId = task.knowledgeBaseId
    const config = task.config

    // 后台异步执行重试（不阻塞）
    documentSyncService.retryFailedDocuments(taskId, knowledgeBaseId, config).catch((error) => {
      console.error('Background retry failed:', error)
    })

    return c.json({
      code: 200,
      success: true,
      message: 'Retry task created successfully',
      data: {
        taskId,
        retryableCount: retryableDocs.length,
        status: 'running'
      }
    })
  } catch (error: any) {
    return c.json(
      {
        code: 400,
        success: false,
        message: error.message || 'Failed to retry failed documents',
        data: null
      },
      400
    )
  }
})

/**
 * 重试单个失败文档
 * POST /knowledge-base/sync-task/:taskId/retry-document/:docId
 */
export const retryDocument = new Hono().post('/sync-task/:taskId/retry-document/:docId', async (c) => {
  try {
    const taskId = c.req.param('taskId')
    const docId = c.req.param('docId')

    if (!taskId || !docId) {
      return c.json(
        {
          code: 400,
          success: false,
          message: 'Task ID and Document ID are required',
          data: null
        },
        400
      )
    }

    // 获取任务状态
    const task = await syncTaskService.getTaskStatus(taskId)
    if (!task) {
      return c.json(
        {
          code: 404,
          success: false,
          message: 'Task not found',
          data: null
        },
        404
      )
    }

    // 查找失败文档
    const failedDoc = task.failedDocuments.find((doc) => doc.docId === docId)
    if (!failedDoc) {
      return c.json(
        {
          code: 404,
          success: false,
          message: 'Failed document not found',
          data: null
        },
        404
      )
    }

    if (failedDoc.canRetry === false) {
      return c.json(
        {
          code: 400,
          success: false,
          message: `Document cannot be retried (error type: ${failedDoc.errorType})`,
          data: null
        },
        400
      )
    }

    // 获取知识库ID和配置
    const knowledgeBaseId = task.knowledgeBaseId
    const config = task.config

    // 后台异步执行重试（不阻塞）
    documentSyncService.retryDocument(taskId, knowledgeBaseId, docId, config).catch((error) => {
      console.error('Background retry failed:', error)
    })

    return c.json({
      code: 200,
      success: true,
      message: 'Retry task created successfully',
      data: {
        taskId,
        docId,
        status: 'running'
      }
    })
  } catch (error: any) {
    return c.json(
      {
        code: 400,
        success: false,
        message: error.message || 'Failed to retry document',
        data: null
      },
      400
    )
  }
})
