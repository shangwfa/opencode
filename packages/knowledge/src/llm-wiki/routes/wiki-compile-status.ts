import { Hono } from 'hono'
import { wikiCompilerService } from '../services/index.js'

export const wikiCompileRetry = new Hono().post('/compile/:taskId/retry', async (c) => {
  try {
    const taskId = c.req.param('taskId')
    const requeued = await wikiCompilerService.retryCompileTask(taskId)
    if (!requeued) {
      return c.json(
        { code: 400, success: false, message: `Compile task ${taskId} is not retryable (not failed, over attempt limit, or another task is active)`, data: null },
        400
      )
    }
    return c.json({ code: 200, success: true, message: 'Compile task requeued', data: { taskId, status: 'pending' } })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to retry compile task'
    return c.json({ code: 500, success: false, message, data: null }, 500)
  }
})

export const wikiCompileCancel = new Hono().post('/compile/:taskId/cancel', async (c) => {
  try {
    const cancelled = await wikiCompilerService.cancelCompileTask(c.req.param('taskId'))
    if (!cancelled) return c.json({ code: 400, success: false, message: 'Task is not cancellable (unknown, or already finished)', data: null }, 400)
    return c.json({ code: 200, success: true, message: 'Compile task cancelled', data: null })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to cancel compile task'
    return c.json({ code: 500, success: false, message, data: null }, 500)
  }
})

export const wikiCompileStatus = new Hono().get('/compile/:taskId', async (c) => {
  try {
    const taskId = c.req.param('taskId')

    if (!taskId) {
      return c.json(
        { code: 400, success: false, message: 'taskId is required', data: null },
        400
      )
    }

    const task = await wikiCompilerService.getCompileTask(taskId)

    if (!task) {
      return c.json(
        { code: 404, success: false, message: `Compile task ${taskId} not found`, data: null },
        404
      )
    }

    return c.json({
      code: 200,
      success: true,
      message: 'Success',
      data: {
        taskId: task.id,
        status: task.status,
        progress: task.progress,
        error: task.error || null,
        documentId: task.documentId ?? null,
        attempt: task.attempt ?? 0,
        startedAt: task.startedAt || null,
        completedAt: task.completedAt || null
      }
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to get compile task status'
    return c.json(
      { code: 500, success: false, message, data: null },
      500
    )
  }
})
