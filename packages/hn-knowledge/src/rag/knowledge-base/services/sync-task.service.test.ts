import { describe, it, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test'
import type { SyncTaskConfig, SyncTaskProgress } from './sync-task.service.js'
type SyncTaskService = import('./sync-task.service.js').SyncTaskService

// Mock数据库
mock.module('../../../db/index.js', () => {
  const mockDb = {
    insert: mock(),
    select: mock(),
    update: mock()
  }

  const mockSyncTasks = {
    id: 'id',
    knowledgeBaseId: 'knowledge_base_id',
    status: 'status',
    config: 'config',
    progress: 'progress',
    failedDocuments: 'failed_documents',
    error: 'error',
    startedAt: 'started_at',
    completedAt: 'completed_at',
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  }

  return {
    db: mockDb,
    syncTasks: mockSyncTasks
  }
})

mock.module('drizzle-orm', () => ({
  eq: (field: any) => field
}))

// 导入mock后的模块（bun：mock.module 之后动态导入）
const { db } = await import('../../../db/index.js')
const { SyncTaskService } = await import('./sync-task.service.js')

describe('SyncTaskService', () => {
  let service: SyncTaskService

  beforeEach(() => {
    // 抑制console.error输出，避免测试输出混乱
    spyOn(console, 'error').mockImplementation(() => {})

    service = new SyncTaskService()
    mock.clearAllMocks()
    // 重置mock实现
    ;(db.insert as any).mockReturnValue({
      values: mock().mockReturnThis()
    })
  })

  afterEach(() => {
    mock.restore()
  })

  describe('createTask', () => {
    it('应该创建新任务', async () => {
      ;(db.insert as any).mockReturnValue({
        values: mock().mockReturnThis()
      })

      const config: SyncTaskConfig = {
        brandCode: 'rpa',
        languageCode: 'zh-CN'
      }

      const taskId = await service.createTask('kb_123', config)

      expect(taskId).toMatch(/^task_\d+_[a-z0-9]+$/)
      expect(db.insert).toHaveBeenCalled()
    })

    it('应该生成唯一的任务ID', async () => {
      ;(db.insert as any).mockReturnValue({
        values: mock().mockReturnThis()
      })

      const config: SyncTaskConfig = {
        brandCode: 'rpa',
        languageCode: 'zh-CN'
      }

      const taskId1 = await service.createTask('kb_123', config)
      const taskId2 = await service.createTask('kb_123', config)

      expect(taskId1).not.toBe(taskId2)
    })

    it('应该在数据库错误时抛出异常', async () => {
      ;(db.insert as any).mockReturnValue({
        values: mock().mockImplementation(() => {
          throw new Error('Database error')
        })
      })

      const config: SyncTaskConfig = {
        brandCode: 'rpa',
        languageCode: 'zh-CN'
      }

      await expect(service.createTask('kb_123', config)).rejects.toThrow(
        'Failed to create sync task'
      )
    })
  })

  describe('getTaskStatus', () => {
    it('应该获取存在的任务', async () => {
      const mockTask = {
        id: 'task_123',
        knowledgeBaseId: 'kb_123',
        status: 'running',
        config: { brandCode: 'rpa', languageCode: 'zh-CN' },
        progress: { total: 10, processed: 5, success: 4, failed: 1, skipped: 0 },
        failedDocuments: [],
        error: null,
        startedAt: new Date('2024-01-01'),
        completedAt: null,
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01')
      }

      ;(db.select as any).mockReturnValue({
        from: mock().mockReturnValue({
          where: mock().mockReturnValue({
            limit: mock().mockResolvedValue([mockTask])
          })
        })
      })

      const result = await service.getTaskStatus('task_123')

      expect(result).not.toBeNull()
      expect(result?.id).toBe('task_123')
      expect(result?.status).toBe('running')
    })

    it('应该对不存在的任务返回null', async () => {
      ;(db.select as any).mockReturnValue({
        from: mock().mockReturnValue({
          where: mock().mockReturnValue({
            limit: mock().mockResolvedValue([])
          })
        })
      })

      const result = await service.getTaskStatus('nonexistent')

      expect(result).toBeNull()
    })

    it('应该在数据库查询错误时抛出异常', async () => {
      const dbError = new Error('Database query failed')
      ;(db.select as any).mockReturnValue({
        from: mock().mockReturnValue({
          where: mock().mockReturnValue({
            limit: mock().mockRejectedValue(dbError)
          })
        })
      })

      await expect(service.getTaskStatus('task_123')).rejects.toThrow(
        'Failed to get task status'
      )
    })
  })

  describe('updateTaskProgress', () => {
    it('应该更新进度（部分更新）', async () => {
      const existingTask = {
        id: 'task_123',
        knowledgeBaseId: 'kb_123',
        status: 'running' as const,
        config: { brandCode: 'rpa', languageCode: 'zh-CN' },
        progress: { total: 10, processed: 5, success: 4, failed: 1, skipped: 0 },
        failedDocuments: [],
        createdAt: new Date(),
        updatedAt: new Date()
      }

      ;(db.select as any).mockReturnValue({
        from: mock().mockReturnValue({
          where: mock().mockReturnValue({
            limit: mock().mockResolvedValue([existingTask])
          })
        })
      })

      ;(db.update as any).mockReturnValue({
        set: mock().mockReturnValue({
          where: mock().mockResolvedValue(undefined)
        })
      })

      await service.updateTaskProgress('task_123', { processed: 6, success: 5 })

      expect(db.update).toHaveBeenCalled()
    })

    it('应该更新进度（完整更新）', async () => {
      const existingTask = {
        id: 'task_123',
        knowledgeBaseId: 'kb_123',
        status: 'running' as const,
        config: { brandCode: 'rpa', languageCode: 'zh-CN' },
        progress: { total: 10, processed: 5, success: 4, failed: 1, skipped: 0 },
        failedDocuments: [],
        createdAt: new Date(),
        updatedAt: new Date()
      }

      ;(db.select as any).mockReturnValue({
        from: mock().mockReturnValue({
          where: mock().mockReturnValue({
            limit: mock().mockResolvedValue([existingTask])
          })
        })
      })

      ;(db.update as any).mockReturnValue({
        set: mock().mockReturnValue({
          where: mock().mockResolvedValue(undefined)
        })
      })

      const newProgress: SyncTaskProgress = {
        total: 10,
        processed: 10,
        success: 8,
        failed: 1,
        skipped: 1
      }

      await service.updateTaskProgress('task_123', newProgress)

      expect(db.update).toHaveBeenCalled()
    })

    it('应该在任务不存在时抛出异常', async () => {
      ;(db.select as any).mockReturnValue({
        from: mock().mockReturnValue({
          where: mock().mockReturnValue({
            limit: mock().mockResolvedValue([])
          })
        })
      })

      await expect(service.updateTaskProgress('nonexistent', { processed: 1 })).rejects.toThrow(
        'Task not found'
      )
    })

    it('应该正确处理增量更新（多次调用后的累加验证）', async () => {
      // 测试场景：连续处理多个文档，每次传入增量值
      const existingTask = {
        id: 'task_123',
        knowledgeBaseId: 'kb_123',
        status: 'running' as const,
        config: { brandCode: 'rpa', languageCode: 'zh-CN' },
        progress: { total: 10, processed: 5, success: 4, failed: 0, skipped: 1 },
        failedDocuments: [],
        createdAt: new Date(),
        updatedAt: new Date()
      }

      let callCount = 0
      let capturedProgress: any[] = []

      // Mock select 返回当前任务状态（每次调用返回最新的状态）
      ;(db.select as any).mockImplementation(() => {
        callCount++
        // 根据调用次数返回不同的状态
        const progressStates = [
          existingTask.progress,  // 第1次调用：processed: 5, success: 4
          { total: 10, processed: 6, success: 5, failed: 0, skipped: 1 },  // 第2次：processed: 6
          { total: 10, processed: 7, success: 6, failed: 0, skipped: 1 },  // 第3次：processed: 7
        ]
        const currentIndex = Math.min(callCount - 1, progressStates.length - 1)

        return {
          from: mock().mockReturnValue({
            where: mock().mockReturnValue({
              limit: mock().mockResolvedValue([
                {
                  ...existingTask,
                  progress: progressStates[currentIndex]
                }
              ])
            })
          })
        }
      })

      // Mock update 并捕获传入的进度值
      ;(db.update as any).mockReturnValue({
        set: mock().mockImplementation((data: any) => {
          capturedProgress.push(data.progress)
          return {
            where: mock().mockResolvedValue(undefined)
          }
        })
      })

      // 第一次更新：processed从5增加到6，success从4增加到5
      await service.updateTaskProgress('task_123', { processed: 6, success: 5 })

      // 第二次更新：processed从6增加到7，success从5增加到6
      await service.updateTaskProgress('task_123', { processed: 7, success: 6 })

      // 第三次更新：只更新failed，其他字段保持不变
      await service.updateTaskProgress('task_123', { failed: 1 })

      // 验证每次update调用时传入的实际值
      expect(capturedProgress).toHaveLength(3)

      // 第一次：processed: 6, success: 5, failed: 0（旧值）, skipped: 1（旧值）
      expect(capturedProgress[0]).toEqual({
        total: 10,
        processed: 6,
        success: 5,
        failed: 0,
        skipped: 1
      })

      // 第二次：processed: 7, success: 6
      expect(capturedProgress[1]).toEqual({
        total: 10,
        processed: 7,
        success: 6,
        failed: 0,
        skipped: 1
      })

      // 第三次：failed更新为1，其他保持不变
      expect(capturedProgress[2]).toEqual({
        total: 10,
        processed: 7,
        success: 6,
        failed: 1,
        skipped: 1
      })

      expect(db.update).toHaveBeenCalledTimes(3)
    })

    it('应该检测错误的增量更新（Bug场景：传入+1而不是current+1）', async () => {
      // 这个测试专门用于捕获当前代码中的bug
      // bug: 传入 { processed: +1 } 会被设置为1，而不是 current + 1
      const existingTask = {
        id: 'task_123',
        knowledgeBaseId: 'kb_123',
        status: 'running' as const,
        config: { brandCode: 'rpa', languageCode: 'zh-CN' },
        progress: { total: 10, processed: 5, success: 4, failed: 0, skipped: 1 },
        failedDocuments: [],
        createdAt: new Date(),
        updatedAt: new Date()
      }

      ;(db.select as any).mockReturnValue({
        from: mock().mockReturnValue({
          where: mock().mockReturnValue({
            limit: mock().mockResolvedValue([existingTask])
          })
        })
      })

      let capturedProgress: any = null
      ;(db.update as any).mockReturnValue({
        set: mock().mockImplementation((data: any) => {
          capturedProgress = data.progress
          return {
            where: mock().mockResolvedValue(undefined)
          }
        })
      })

      // ❌ 错误的调用方式（当前代码中的bug）
      await service.updateTaskProgress('task_123', {
        processed: +1,  // +1 是一元操作符，结果就是数字1
        failed: +1
      })

      // 验证：processed会被设置为1，而不是6（5+1）
      expect(capturedProgress.processed).toBe(1)  // Bug暴露：应该是6，实际是1
      expect(capturedProgress.failed).toBe(1)     // Bug暴露：应该是1，这个碰巧对了
      expect(capturedProgress.success).toBe(4)    // 保持原值

      // ✅ 正确的调用方式应该是：
      // await service.updateTaskProgress('task_123', {
      //   processed: existingTask.progress.processed + 1,  // 5 + 1 = 6
      //   failed: existingTask.progress.failed + 1         // 0 + 1 = 1
      // })
    })
  })

  describe('updateTaskStatus', () => {
    it('应该更新状态（pending → running）', async () => {
      const existingTask = {
        id: 'task_123',
        knowledgeBaseId: 'kb_123',
        status: 'pending' as const,
        config: { brandCode: 'rpa', languageCode: 'zh-CN' },
        progress: { total: 0, processed: 0, success: 0, failed: 0, skipped: 0 },
        failedDocuments: [],
        startedAt: null,
        completedAt: null,
        createdAt: new Date(),
        updatedAt: new Date()
      }

      ;(db.select as any).mockReturnValue({
        from: mock().mockReturnValue({
          where: mock().mockReturnValue({
            limit: mock().mockResolvedValue([existingTask])
          })
        })
      })

      ;(db.update as any).mockReturnValue({
        set: mock().mockReturnValue({
          where: mock().mockResolvedValue(undefined)
        })
      })

      await service.updateTaskStatus('task_123', 'running')

      expect(db.update).toHaveBeenCalled()
      const setCall = (db.update as any)().set.mock.calls[0]
      expect(setCall[0].status).toBe('running')
      expect(setCall[0].startedAt).toBeInstanceOf(Date)
    })

    it('应该更新状态（running → completed）', async () => {
      const existingTask = {
        id: 'task_123',
        knowledgeBaseId: 'kb_123',
        status: 'running' as const,
        config: { brandCode: 'rpa', languageCode: 'zh-CN' },
        progress: { total: 10, processed: 10, success: 10, failed: 0, skipped: 0 },
        failedDocuments: [],
        startedAt: new Date('2024-01-01'),
        completedAt: null,
        createdAt: new Date(),
        updatedAt: new Date()
      }

      ;(db.select as any).mockReturnValue({
        from: mock().mockReturnValue({
          where: mock().mockReturnValue({
            limit: mock().mockResolvedValue([existingTask])
          })
        })
      })

      ;(db.update as any).mockReturnValue({
        set: mock().mockReturnValue({
          where: mock().mockResolvedValue(undefined)
        })
      })

      await service.updateTaskStatus('task_123', 'completed')

      expect(db.update).toHaveBeenCalled()
      const setCall = (db.update as any)().set.mock.calls[0]
      expect(setCall[0].status).toBe('completed')
      expect(setCall[0].completedAt).toBeInstanceOf(Date)
    })

    it('应该更新状态（running → failed）', async () => {
      const existingTask = {
        id: 'task_123',
        knowledgeBaseId: 'kb_123',
        status: 'running' as const,
        config: { brandCode: 'rpa', languageCode: 'zh-CN' },
        progress: { total: 10, processed: 5, success: 3, failed: 2, skipped: 0 },
        failedDocuments: [],
        startedAt: new Date('2024-01-01'),
        completedAt: null,
        createdAt: new Date(),
        updatedAt: new Date()
      }

      ;(db.select as any).mockReturnValue({
        from: mock().mockReturnValue({
          where: mock().mockReturnValue({
            limit: mock().mockResolvedValue([existingTask])
          })
        })
      })

      ;(db.update as any).mockReturnValue({
        set: mock().mockReturnValue({
          where: mock().mockResolvedValue(undefined)
        })
      })

      await service.updateTaskStatus('task_123', 'failed', 'Sync failed')

      expect(db.update).toHaveBeenCalled()
      const setCall = (db.update as any)().set.mock.calls[0]
      expect(setCall[0].status).toBe('failed')
      expect(setCall[0].error).toBe('Sync failed')
      expect(setCall[0].completedAt).toBeInstanceOf(Date)
    })

    it('应该在数据库更新错误时抛出异常', async () => {
      const existingTask = {
        id: 'task_123',
        knowledgeBaseId: 'kb_123',
        status: 'running' as const,
        config: { brandCode: 'rpa', languageCode: 'zh-CN' },
        progress: { total: 10, processed: 5, success: 3, failed: 2, skipped: 0 },
        failedDocuments: [],
        startedAt: new Date('2024-01-01'),
        completedAt: null,
        createdAt: new Date(),
        updatedAt: new Date()
      }

      const dbError = new Error('Database update failed')

      ;(db.select as any).mockReturnValue({
        from: mock().mockReturnValue({
          where: mock().mockReturnValue({
            limit: mock().mockResolvedValue([existingTask])
          })
        })
      })

      ;(db.update as any).mockReturnValue({
        set: mock().mockReturnValue({
          where: mock().mockRejectedValue(dbError)
        })
      })

      await expect(service.updateTaskStatus('task_123', 'failed', 'Error')).rejects.toThrow(
        'Failed to update task status'
      )
    })
  })

  describe('addFailedDocument', () => {
    it('应该添加失败文档记录', async () => {
      const existingTask = {
        id: 'task_123',
        knowledgeBaseId: 'kb_123',
        status: 'running' as const,
        config: { brandCode: 'rpa', languageCode: 'zh-CN' },
        progress: { total: 10, processed: 5, success: 4, failed: 1, skipped: 0 },
        failedDocuments: [],
        createdAt: new Date(),
        updatedAt: new Date()
      }

      ;(db.select as any).mockReturnValue({
        from: mock().mockReturnValue({
          where: mock().mockReturnValue({
            limit: mock().mockResolvedValue([existingTask])
          })
        })
      })

      ;(db.update as any).mockReturnValue({
        set: mock().mockReturnValue({
          where: mock().mockResolvedValue(undefined)
        })
      })

      const failedDoc = {
        docId: 'doc_123',
        docName: '测试文档',
        error: 'Processing failed',
        retryCount: 3
      }

      await service.addFailedDocument('task_123', failedDoc)

      expect(db.update).toHaveBeenCalled()
    })

    it('应该多次添加失败文档', async () => {
      const existingTask = {
        id: 'task_123',
        knowledgeBaseId: 'kb_123',
        status: 'running' as const,
        config: { brandCode: 'rpa', languageCode: 'zh-CN' },
        progress: { total: 10, processed: 5, success: 4, failed: 1, skipped: 0 },
        failedDocuments: [
          {
            docId: 'doc_1',
            docName: '文档1',
            error: 'Error 1',
            retryCount: 2
          }
        ],
        createdAt: new Date(),
        updatedAt: new Date()
      }

      let callCount = 0
      ;(db.select as any).mockImplementation(() => {
        callCount++
        if (callCount === 1) {
          return {
            from: mock().mockReturnValue({
              where: mock().mockReturnValue({
                limit: mock().mockResolvedValue([existingTask])
              })
            })
          }
        } else {
          // 第二次调用返回更新后的任务
          const updatedTask = {
            ...existingTask,
            failedDocuments: [
              ...existingTask.failedDocuments,
              {
                docId: 'doc_2',
                docName: '文档2',
                error: 'Error 2',
                retryCount: 1
              }
            ]
          }
          return {
            from: mock().mockReturnValue({
              where: mock().mockReturnValue({
                limit: mock().mockResolvedValue([updatedTask])
              })
            })
          }
        }
      })

      ;(db.update as any).mockReturnValue({
        set: mock().mockReturnValue({
          where: mock().mockResolvedValue(undefined)
        })
      })

      const failedDoc1 = {
        docId: 'doc_2',
        docName: '文档2',
        error: 'Error 2',
        retryCount: 1
      }

      await service.addFailedDocument('task_123', failedDoc1)

      expect(db.update).toHaveBeenCalled()
    })

    it('应该在任务不存在时抛出异常', async () => {
      ;(db.select as any).mockReturnValue({
        from: mock().mockReturnValue({
          where: mock().mockReturnValue({
            limit: mock().mockResolvedValue([])
          })
        })
      })

      const failedDoc = {
        docId: 'doc_123',
        docName: '测试文档',
        error: 'Processing failed',
        retryCount: 3
      }

      await expect(service.addFailedDocument('nonexistent', failedDoc)).rejects.toThrow(
        'Task not found'
      )
    })
  })

  describe('removeFailedDocument', () => {
    it('应该从失败列表中移除文档', async () => {
      const existingTask = {
        id: 'task_123',
        knowledgeBaseId: 'kb_123',
        status: 'running' as const,
        config: { brandCode: 'rpa', languageCode: 'zh-CN' },
        progress: { total: 10, processed: 5, success: 4, failed: 1, skipped: 0 },
        failedDocuments: [
          {
            docId: 'doc_1',
            docName: '文档1',
            error: 'Error 1',
            retryCount: 2
          },
          {
            docId: 'doc_2',
            docName: '文档2',
            error: 'Error 2',
            retryCount: 1
          }
        ],
        createdAt: new Date(),
        updatedAt: new Date()
      }

      ;(db.select as any).mockReturnValue({
        from: mock().mockReturnValue({
          where: mock().mockReturnValue({
            limit: mock().mockResolvedValue([existingTask])
          })
        })
      })

      const setMock = mock().mockReturnValue({
        where: mock().mockResolvedValue(undefined)
      })

      ;(db.update as any).mockReturnValue({
        set: setMock
      })

      await service.removeFailedDocument('task_123', 'doc_1')

      expect(db.update).toHaveBeenCalled()
      expect(setMock).toHaveBeenCalled()
      const setCall = setMock.mock.calls[0][0]
      expect(setCall.failedDocuments).toHaveLength(1)
      expect(setCall.failedDocuments[0].docId).toBe('doc_2')
    })

    it('应该在任务不存在时抛出异常', async () => {
      ;(db.select as any).mockReturnValue({
        from: mock().mockReturnValue({
          where: mock().mockReturnValue({
            limit: mock().mockResolvedValue([])
          })
        })
      })

      await expect(service.removeFailedDocument('nonexistent', 'doc_1')).rejects.toThrow(
        'Task not found'
      )
    })
  })

  describe('updateTaskStatus - 部分成功状态', () => {
    it('应该支持部分成功状态', async () => {
      const existingTask = {
        id: 'task_123',
        knowledgeBaseId: 'kb_123',
        status: 'running' as const,
        config: { brandCode: 'rpa', languageCode: 'zh-CN' },
        progress: { total: 10, processed: 10, success: 8, failed: 2, skipped: 0 },
        failedDocuments: [],
        createdAt: new Date(),
        updatedAt: new Date()
      }

      ;(db.select as any).mockReturnValue({
        from: mock().mockReturnValue({
          where: mock().mockReturnValue({
            limit: mock().mockResolvedValue([existingTask])
          })
        })
      })

      const setMock = mock().mockReturnValue({
        where: mock().mockResolvedValue(undefined)
      })

      ;(db.update as any).mockReturnValue({
        set: setMock
      })

      await service.updateTaskStatus('task_123', 'partially_completed')

      expect(db.update).toHaveBeenCalled()
      expect(setMock).toHaveBeenCalled()
      const setCall = setMock.mock.calls[0][0]
      expect(setCall.status).toBe('partially_completed')
      expect(setCall.completedAt).toBeDefined()
    })
  })
})

