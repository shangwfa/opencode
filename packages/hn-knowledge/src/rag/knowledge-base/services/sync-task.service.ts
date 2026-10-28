/**
 * 同步任务状态管理服务
 * 使用数据库存储任务状态，支持任务创建、状态跟踪和进度更新
 */

import { db, syncTasks } from '../../../db/index.js'
import { eq } from 'drizzle-orm'

export type SyncTaskStatus = 'pending' | 'running' | 'completed' | 'partially_completed' | 'failed'

export type SyncTaskOperation =
  | 'syncFromYydoc'
  | 'syncYydocDocuments'
  | 'upsertDocument'
  | 'deleteDocument'
  | 'batchUpsertDocuments'
  | 'batchDeleteDocuments'

export interface DocPlatformSyncDocument {
  docUniqueId: string
  menuId?: string
  name?: string
  content?: any
  force?: boolean
  docPath?: string
  parentPath?: string
  metadata?: Record<string, any>
}

export interface SyncTaskConfig {
  brandCode: string
  languageCode: string
  operation?: SyncTaskOperation
  chunkStrategy?: string
  chunkConfig?: any
  maxDocs?: number // 最大文档数量限制（用于测试）
  documents?: DocPlatformSyncDocument[]
}

export interface SyncTaskProgress {
  total: number // 总文档数
  processed: number // 已处理数（包括成功、失败、跳过）
  success: number // 成功数
  failed: number // 失败数
  skipped: number // 跳过数（已存在且未变更）
}

export type ErrorType = 'temporary' | 'permanent' | 'data'

export interface FailedDocument {
  docId: string
  docName: string
  error: string
  retryCount: number
  errorType?: ErrorType // 错误类型：临时性、永久性、数据错误
  failedAt?: string // 失败时间
  canRetry?: boolean // 是否可以重试
  operation?: SyncTaskOperation
  targetHash?: string
  context?: Record<string, any>
}

export interface SyncTask {
  id: string
  knowledgeBaseId: string
  status: SyncTaskStatus
  config: SyncTaskConfig
  progress: SyncTaskProgress
  failedDocuments: FailedDocument[]
  error?: string
  startedAt?: Date
  completedAt?: Date
  createdAt: Date
  updatedAt: Date
}

export class SyncTaskService {
  /**
   * 创建新任务
   * @param knowledgeBaseId - 知识库ID
   * @param config - 任务配置
   * @returns 任务ID
   */
  async createTask(knowledgeBaseId: string, config: SyncTaskConfig): Promise<string> {
    const taskId = `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    const now = new Date()

    const initialProgress: SyncTaskProgress = {
      total: 0,
      processed: 0,
      success: 0,
      failed: 0,
      skipped: 0
    }

    try {
      await db.insert(syncTasks).values({
        id: taskId,
        knowledgeBaseId,
        status: 'pending',
        config: config as any,
        progress: initialProgress as any,
        failedDocuments: [] as any,
        createdAt: now,
        updatedAt: now
      })

      return taskId
    } catch (error: any) {
      console.error('Error creating sync task:', error.message)
      throw new Error(`Failed to create sync task: ${error.message}`)
    }
  }

  /**
   * 获取任务状态
   * @param taskId - 任务ID
   * @returns 任务状态信息
   */
  async getTaskStatus(taskId: string): Promise<SyncTask | null> {
    try {
      const [result] = await db.select().from(syncTasks).where(eq(syncTasks.id, taskId)).limit(1)

      if (!result) {
        return null
      }

      return {
        id: result.id,
        knowledgeBaseId: result.knowledgeBaseId,
        status: result.status as SyncTaskStatus,
        config: result.config as any as SyncTaskConfig,
        progress: result.progress as any as SyncTaskProgress,
        failedDocuments: (result.failedDocuments as any) || [],
        error: result.error || undefined,
        startedAt: result.startedAt || undefined,
        completedAt: result.completedAt || undefined,
        createdAt: result.createdAt,
        updatedAt: result.updatedAt
      }
    } catch (error: any) {
      console.error('Error getting task status:', error.message)
      throw new Error(`Failed to get task status: ${error.message}`)
    }
  }

  /**
   * 更新任务进度
   * @param taskId - 任务ID
   * @param progress - 进度信息（支持部分更新）
   */
  async updateTaskProgress(taskId: string, progress: Partial<SyncTaskProgress>): Promise<void> {
    try {
      // 先获取当前进度
      const task = await this.getTaskStatus(taskId)
      if (!task) {
        throw new Error(`Task not found: ${taskId}`)
      }

      // 合并进度
      const updatedProgress: SyncTaskProgress = {
        ...task.progress,
        ...progress
      }

      await db
        .update(syncTasks)
        .set({
          progress: updatedProgress as any,
          updatedAt: new Date()
        })
        .where(eq(syncTasks.id, taskId))
    } catch (error: any) {
      console.error('Error updating task progress:', error.message)
      throw new Error(`Failed to update task progress: ${error.message}`)
    }
  }

  /**
   * 增量更新任务进度（自动累加）
   * @param taskId - 任务ID
   * @param increments - 要增加的进度值
   */
  async incrementTaskProgress(taskId: string, increments: Partial<SyncTaskProgress>): Promise<void> {
    try {
      // 先获取当前进度
      const task = await this.getTaskStatus(taskId)
      if (!task) {
        throw new Error(`Task not found: ${taskId}`)
      }

      // 累加进度
      const updatedProgress: SyncTaskProgress = {
        total: increments.total ?? task.progress.total,
        processed: (task.progress.processed || 0) + (increments.processed || 0),
        success: (task.progress.success || 0) + (increments.success || 0),
        failed: (task.progress.failed || 0) + (increments.failed || 0),
        skipped: (task.progress.skipped || 0) + (increments.skipped || 0)
      }

      await db
        .update(syncTasks)
        .set({
          progress: updatedProgress as any,
          updatedAt: new Date()
        })
        .where(eq(syncTasks.id, taskId))
    } catch (error: any) {
      console.error('Error incrementing task progress:', error.message)
      throw new Error(`Failed to increment task progress: ${error.message}`)
    }
  }

  /**
   * 更新任务状态
   * @param taskId - 任务ID
   * @param status - 新状态
   * @param error - 错误信息（可选）
   */
  async updateTaskStatus(taskId: string, status: SyncTaskStatus, error?: string): Promise<void> {
    try {
      const updateData: any = {
        status,
        updatedAt: new Date()
      }

      if (status === 'running' && !error) {
        // 如果状态变为running，设置startedAt
        const task = await this.getTaskStatus(taskId)
        if (task && !task.startedAt) {
          updateData.startedAt = new Date()
        }
      }

      if (status === 'completed' || status === 'partially_completed' || status === 'failed') {
        updateData.completedAt = new Date()
      }

      if (error) {
        updateData.error = error
      }

      await db.update(syncTasks).set(updateData).where(eq(syncTasks.id, taskId))
    } catch (error: any) {
      console.error('Error updating task status:', error.message)
      throw new Error(`Failed to update task status: ${error.message}`)
    }
  }

  /**
   * 添加失败文档记录
   * @param taskId - 任务ID
   * @param failedDoc - 失败文档信息
   */
  async addFailedDocument(taskId: string, failedDoc: FailedDocument): Promise<void> {
    try {
      const task = await this.getTaskStatus(taskId)
      if (!task) {
        throw new Error(`Task not found: ${taskId}`)
      }

      const failedDocuments = [...task.failedDocuments, failedDoc]

      await db
        .update(syncTasks)
        .set({
          failedDocuments: failedDocuments as any,
          updatedAt: new Date()
        })
        .where(eq(syncTasks.id, taskId))
    } catch (error: any) {
      console.error('Error adding failed document:', error.message)
      throw new Error(`Failed to add failed document: ${error.message}`)
    }
  }

  /**
   * 从失败列表中移除文档（重试成功时调用）
   * @param taskId - 任务ID
   * @param docId - 文档ID
   */
  async removeFailedDocument(taskId: string, docId: string): Promise<void> {
    try {
      const task = await this.getTaskStatus(taskId)
      if (!task) {
        throw new Error(`Task not found: ${taskId}`)
      }

      const failedDocuments = task.failedDocuments.filter((doc) => doc.docId !== docId)

      await db
        .update(syncTasks)
        .set({
          failedDocuments: failedDocuments as any,
          updatedAt: new Date()
        })
        .where(eq(syncTasks.id, taskId))
    } catch (error: any) {
      console.error('Error removing failed document:', error.message)
      throw new Error(`Failed to remove failed document: ${error.message}`)
    }
  }
}
