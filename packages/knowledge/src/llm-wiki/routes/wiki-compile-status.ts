import { Hono } from 'hono'
import { wikiCompilerService } from '../services/index.js'

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
