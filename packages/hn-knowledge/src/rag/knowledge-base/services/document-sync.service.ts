/**
 * 文档同步服务
 * 实现菜单遍历和文档串行处理逻辑
 * 支持进度更新、失败重试、跳过已处理文档、内容哈希判断
 */

import { createHash } from 'crypto'
import { YddocApiService } from './yddoc-api.service.js'
import { KnowledgeBaseService } from './knowledge-base.service.js'
import { DocumentService } from './document.service.js'
import { VectorService } from './vector.service.js'
import { SyncTaskService } from './sync-task.service.js'
import type { SyncTaskConfig, FailedDocument, DocPlatformSyncDocument } from './sync-task.service.js'

interface DocumentInfo {
  id: string
  name: string
  path: string // 完整路径，如 "教程/快速开始/入门指南"
  parentPath: string // 父级路径，如 "教程/快速开始"
  menuId?: string
  metadata?: Record<string, any>
  force?: boolean
}

/**
 * 从 Tiptap JSON 中提取文本内容（降级策略）
 */
function extractTextFromTiptap(node: any): string {
  if (!node) return ''

  if (typeof node === 'string') {
    return node
  }

  if (node.text) {
    return node.text
  }

  if (node.content && Array.isArray(node.content)) {
    return node.content
      .map((child: any) => extractTextFromTiptap(child))
      .filter((text: string) => text && text.trim().length > 0)
      .join(' ')
  }

  return ''
}

interface RetryConfig {
  maxRetries: number
  retryDelay: number
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  retryDelay: 1000
}

/**
 * 延迟函数
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 计算内容哈希
 */
function calculateContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * 错误类型枚举
 */
export type ErrorType = 'temporary' | 'permanent' | 'data'

/**
 * 分类错误类型
 */
function classifyError(error: any): { type: ErrorType; canRetry: boolean } {
  const errorMessage = error.message || error.toString() || ''

  // 永久性错误：404、内容格式错误、权限错误、知识库不存在
  if (
    errorMessage.includes('HTTP 404') ||
    errorMessage.includes('Not Found') ||
    errorMessage.includes('not found') ||
    errorMessage.includes('Invalid') ||
    errorMessage.includes('unauthorized') ||
    errorMessage.includes('forbidden') ||
    errorMessage.includes('permission denied')
  ) {
    return { type: 'permanent', canRetry: false }
  }

  // 数据错误：向量创建失败、数据库错误、内容为空
  if (
    errorMessage.includes('vector') ||
    errorMessage.includes('database') ||
    errorMessage.includes('empty') ||
    errorMessage.includes('chunk') ||
    errorMessage.includes('embedding')
  ) {
    return { type: 'data', canRetry: true }
  }

  // 临时性错误：网络错误、超时、连接错误、5xx错误
  if (
    errorMessage.includes('ECONNRESET') ||
    errorMessage.includes('ETIMEDOUT') ||
    errorMessage.includes('ENOTFOUND') ||
    errorMessage.includes('timeout') ||
    errorMessage.includes('Failed to fetch') ||
    errorMessage.includes('HTTP 5') ||
    errorMessage.includes('connection') ||
    errorMessage.includes('deadlock')
  ) {
    return { type: 'temporary', canRetry: true }
  }

  // 默认视为临时性错误，可以重试
  return { type: 'temporary', canRetry: true }
}

/**
 * 判断错误是否可重试（向后兼容）
 */
function isRetryableError(error: any): boolean {
  const { canRetry } = classifyError(error)
  return canRetry
}

export class DocumentSyncService {
  private yddocApiService: YddocApiService
  private knowledgeBaseService: KnowledgeBaseService
  private documentService: DocumentService
  private vectorService: VectorService
  private syncTaskService: SyncTaskService
  private retryConfig: RetryConfig

  constructor(
    yddocApiService: YddocApiService,
    knowledgeBaseService: KnowledgeBaseService,
    documentService: DocumentService,
    vectorService: VectorService,
    syncTaskService: SyncTaskService,
    retryConfig?: RetryConfig
  ) {
    this.yddocApiService = yddocApiService
    this.knowledgeBaseService = knowledgeBaseService
    this.documentService = documentService
    this.vectorService = vectorService
    this.syncTaskService = syncTaskService
    this.retryConfig = retryConfig || DEFAULT_RETRY_CONFIG
  }

  /**
   * 主同步方法
   * @param taskId - 任务ID
   * @param knowledgeBaseId - 知识库ID
   * @param config - 同步配置
   */
  async syncDocumentsFromYingdao(taskId: string, knowledgeBaseId: string, config: SyncTaskConfig): Promise<void> {
    try {
      // 更新任务状态为running
      await this.syncTaskService.updateTaskStatus(taskId, 'running')

      // 1. 获取菜单树
      const menuTree = await this.yddocApiService.getMenuTree(config.brandCode, config.languageCode)

      // 2. 提取所有文档ID
      const allDocIdsOriginal = this.yddocApiService.extractAllDocIds(menuTree)
      let allDocIds = allDocIdsOriginal

      // 2.1. 如果配置了maxDocs，限制文档数量（用于测试）
      if (config.maxDocs && config.maxDocs > 0 && allDocIds.length > config.maxDocs) {
        allDocIds = allDocIds.slice(0, config.maxDocs)
        console.log(`[测试模式] 限制文档数量为 ${config.maxDocs} 个（共 ${allDocIdsOriginal.length} 个）`)
      }

      // 3. 更新总文档数
      await this.syncTaskService.updateTaskProgress(taskId, {
        total: allDocIds.length
      })

      // 4. 串行处理每个文档
      for (const docInfo of allDocIds) {
        await this.processDocument(taskId, knowledgeBaseId, docInfo, config)
      }

      // 5. 同步完成（根据是否有失败文档决定状态）
      const task = await this.syncTaskService.getTaskStatus(taskId)
      if (task && task.progress.failed > 0 && task.progress.success > 0) {
        // 有成功也有失败，标记为部分成功
        await this.syncTaskService.updateTaskStatus(taskId, 'partially_completed')
      } else if (task && task.progress.failed > 0) {
        // 全部失败
        await this.syncTaskService.updateTaskStatus(taskId, 'failed')
      } else {
        // 全部成功
        await this.syncTaskService.updateTaskStatus(taskId, 'completed')
      }
    } catch (error: any) {
      console.error('Document sync failed:', error)
      await this.syncTaskService.updateTaskStatus(taskId, 'failed', error.message)
      throw error
    }
  }

  /**
   * 同步指定的文档ID列表
   * @param taskId - 任务ID
   * @param knowledgeBaseId - 知识库ID
   * @param docIds - 要同步的文档ID数组
   * @param config - 同步配置
   */
  async syncDocumentsByIds(
    taskId: string,
    knowledgeBaseId: string,
    docIds: string[],
    config: SyncTaskConfig
  ): Promise<void> {
    try {
      // 更新任务状态为running
      await this.syncTaskService.updateTaskStatus(taskId, 'running')

      // 1. 获取菜单树
      const menuTree = await this.yddocApiService.getMenuTree(config.brandCode, config.languageCode)

      // 2. 提取所有文档信息
      const allDocInfos = this.yddocApiService.extractAllDocIds(menuTree)

      // 3. 从菜单树中查找指定的文档ID
      const docIdSet = new Set(docIds)
      const matchedDocInfos = allDocInfos.filter((docInfo) => docIdSet.has(docInfo.id))

      // 4. 检查是否有文档未找到
      const foundDocIds = new Set(matchedDocInfos.map((doc) => doc.id))
      const notFoundDocIds = docIds.filter((id) => !foundDocIds.has(id))

      if (notFoundDocIds.length > 0) {
        console.warn(`[文档同步] 以下文档ID在菜单树中未找到: ${notFoundDocIds.join(', ')}`)
      }

      if (matchedDocInfos.length === 0) {
        throw new Error(`None of the specified document IDs were found in the menu tree`)
      }

      // 5. 更新总文档数
      await this.syncTaskService.updateTaskProgress(taskId, {
        total: matchedDocInfos.length
      })

      // 6. 串行处理每个文档
      for (const docInfo of matchedDocInfos) {
        await this.processDocument(taskId, knowledgeBaseId, docInfo, config)
      }

      // 7. 同步完成（根据是否有失败文档决定状态）
      const task = await this.syncTaskService.getTaskStatus(taskId)
      if (task && task.progress.failed > 0 && task.progress.success > 0) {
        // 有成功也有失败，标记为部分成功
        await this.syncTaskService.updateTaskStatus(taskId, 'partially_completed')
      } else if (task && task.progress.failed > 0) {
        // 全部失败
        await this.syncTaskService.updateTaskStatus(taskId, 'failed')
      } else {
        // 全部成功
        await this.syncTaskService.updateTaskStatus(taskId, 'completed')
      }
    } catch (error: any) {
      console.error('Document sync by IDs failed:', error)
      await this.syncTaskService.updateTaskStatus(taskId, 'failed', error.message)
      throw error
    }
  }

  /**
   * 同步文档平台触发的文档任务。
   * book-v3 只负责在文档平台变更成功后创建任务，实际知识库增删改在这里统一处理。
   */
  async syncDocumentsFromDocPlatform(taskId: string, knowledgeBaseId: string, config: SyncTaskConfig): Promise<void> {
    try {
      await this.syncTaskService.updateTaskStatus(taskId, 'running')

      const documents = config.documents || []
      await this.syncTaskService.updateTaskProgress(taskId, {
        total: documents.length
      })

      for (const document of documents) {
        if (config.operation === 'deleteDocument' || config.operation === 'batchDeleteDocuments') {
          await this.deleteDocPlatformDocument(taskId, knowledgeBaseId, document, config)
        } else {
          await this.processDocPlatformDocument(taskId, knowledgeBaseId, document, config)
        }
      }

      await this.completeTaskByProgress(taskId)
    } catch (error: any) {
      console.error('Document platform sync failed:', error)
      await this.syncTaskService.updateTaskStatus(taskId, 'failed', error.message)
      throw error
    }
  }

  /**
   * 重试失败文档
   * @param taskId - 任务ID
   * @param knowledgeBaseId - 知识库ID
   * @param config - 同步配置
   */
  async retryFailedDocuments(
    taskId: string,
    knowledgeBaseId: string,
    config: SyncTaskConfig
  ): Promise<void> {
    try {
      // 获取任务状态
      const task = await this.syncTaskService.getTaskStatus(taskId)
      if (!task) {
        throw new Error(`Task not found: ${taskId}`)
      }

      // 获取可重试的失败文档
      const retryableDocs = task.failedDocuments.filter((doc) => doc.canRetry !== false)

      if (retryableDocs.length === 0) {
        console.log(`[重试] 没有可重试的失败文档`)
        return
      }

      console.log(`[重试] 开始重试 ${retryableDocs.length} 个失败文档`)

      // 更新任务状态为running
      await this.syncTaskService.updateTaskStatus(taskId, 'running')

      // 获取菜单树
      const menuTree = await this.yddocApiService.getMenuTree(config.brandCode, config.languageCode)
      const allDocInfos = this.yddocApiService.extractAllDocIds(menuTree)

      // 创建文档ID到文档信息的映射
      const docInfoMap = new Map(allDocInfos.map((info) => [info.id, info]))

      // 更新总文档数（只包含可重试的文档）
      await this.syncTaskService.updateTaskProgress(taskId, {
        total: task.progress.total + retryableDocs.length
      })

      // 串行处理每个可重试的文档
      for (const failedDoc of retryableDocs) {
        const docInfo = docInfoMap.get(failedDoc.docId)
        if (!docInfo) {
          console.warn(`[重试] 文档 ${failedDoc.docId} 在菜单树中未找到，跳过`)
          continue
        }

        // 从失败列表中移除（如果重试成功，会从列表中移除）
        // 这里我们直接处理，如果成功会更新进度，如果失败会重新添加到失败列表
        await this.processDocument(taskId, knowledgeBaseId, docInfo, config)
      }

      // 更新任务状态
      const updatedTask = await this.syncTaskService.getTaskStatus(taskId)
      if (updatedTask) {
        if (updatedTask.progress.failed > 0 && updatedTask.progress.success > 0) {
          await this.syncTaskService.updateTaskStatus(taskId, 'partially_completed')
        } else if (updatedTask.progress.failed > 0) {
          await this.syncTaskService.updateTaskStatus(taskId, 'failed')
        } else {
          await this.syncTaskService.updateTaskStatus(taskId, 'completed')
        }
      }
    } catch (error: any) {
      console.error('Retry failed documents failed:', error)
      await this.syncTaskService.updateTaskStatus(taskId, 'failed', error.message)
      throw error
    }
  }

  /**
   * 重试单个失败文档
   * @param taskId - 任务ID
   * @param knowledgeBaseId - 知识库ID
   * @param docId - 文档ID
   * @param config - 同步配置
   */
  async retryDocument(
    taskId: string,
    knowledgeBaseId: string,
    docId: string,
    config: SyncTaskConfig
  ): Promise<void> {
    try {
      // 获取任务状态
      const task = await this.syncTaskService.getTaskStatus(taskId)
      if (!task) {
        throw new Error(`Task not found: ${taskId}`)
      }

      // 查找失败文档
      const failedDoc = task.failedDocuments.find((doc) => doc.docId === docId)
      if (!failedDoc) {
        throw new Error(`Failed document not found: ${docId}`)
      }

      if (failedDoc.canRetry === false) {
        throw new Error(`Document ${docId} cannot be retried (error type: ${failedDoc.errorType})`)
      }

      console.log(`[重试] 开始重试文档 ${docId}`)

      // 更新任务状态为running
      await this.syncTaskService.updateTaskStatus(taskId, 'running')

      // 获取菜单树
      const menuTree = await this.yddocApiService.getMenuTree(config.brandCode, config.languageCode)
      const allDocInfos = this.yddocApiService.extractAllDocIds(menuTree)

      // 查找文档信息
      const docInfo = allDocInfos.find((info) => info.id === docId)
      if (!docInfo) {
        throw new Error(`Document ${docId} not found in menu tree`)
      }

      // 处理文档
      await this.processDocument(taskId, knowledgeBaseId, docInfo, config)

      // 更新任务状态
      const updatedTask = await this.syncTaskService.getTaskStatus(taskId)
      if (updatedTask) {
        if (updatedTask.progress.failed > 0 && updatedTask.progress.success > 0) {
          await this.syncTaskService.updateTaskStatus(taskId, 'partially_completed')
        } else if (updatedTask.progress.failed > 0) {
          await this.syncTaskService.updateTaskStatus(taskId, 'failed')
        } else {
          await this.syncTaskService.updateTaskStatus(taskId, 'completed')
        }
      }
    } catch (error: any) {
      console.error(`Retry document ${docId} failed:`, error)
      await this.syncTaskService.updateTaskStatus(taskId, 'failed', error.message)
      throw error
    }
  }

  private async completeTaskByProgress(taskId: string): Promise<void> {
    const task = await this.syncTaskService.getTaskStatus(taskId)
    if (task && task.progress.failed > 0 && task.progress.success > 0) {
      await this.syncTaskService.updateTaskStatus(taskId, 'partially_completed')
    } else if (task && task.progress.failed > 0) {
      await this.syncTaskService.updateTaskStatus(taskId, 'failed')
    } else {
      await this.syncTaskService.updateTaskStatus(taskId, 'completed')
    }
  }

  private toDocumentInfo(document: DocPlatformSyncDocument): DocumentInfo {
    return {
      id: document.docUniqueId,
      name: document.name || document.docUniqueId,
      path: document.docPath || document.name || document.docUniqueId,
      parentPath: document.parentPath || '',
      menuId: document.menuId,
      metadata: document.metadata,
      force: document.force
    }
  }

  private async processDocPlatformDocument(
    taskId: string,
    knowledgeBaseId: string,
    document: DocPlatformSyncDocument,
    config: SyncTaskConfig
  ): Promise<void> {
    const docInfo = this.toDocumentInfo(document)
    let lastError: any
    let retryCount = 0
    const contentString = typeof document.content === 'string' ? document.content : JSON.stringify(document.content || '')
    const targetHash = contentString ? calculateContentHash(contentString) : undefined

    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      try {
        if (!document.content) {
          throw new Error(`Document ${docInfo.id} has no content for upsert`)
        }
        await this.processDocumentContentOnce(taskId, knowledgeBaseId, docInfo, config, document.content)
        return
      } catch (error: any) {
        lastError = error
        if (isRetryableError(error) && attempt < this.retryConfig.maxRetries) {
          retryCount++
          const delayMs = this.retryConfig.retryDelay * Math.pow(2, attempt)
          console.warn(
            `Retrying doc-platform document ${docInfo.id} (${docInfo.name}) after ${delayMs}ms (attempt ${attempt + 1}/${
              this.retryConfig.maxRetries + 1
            })`
          )
          await delay(delayMs)
          continue
        }
        break
      }
    }

    const errorClassification = classifyError(lastError)
    await this.syncTaskService.addFailedDocument(taskId, {
      docId: docInfo.id,
      docName: docInfo.name,
      error: lastError?.message || 'Unknown error',
      retryCount,
      errorType: errorClassification.type,
      failedAt: new Date().toISOString(),
      canRetry: errorClassification.canRetry,
      operation: config.operation,
      targetHash,
      context: {
        menuId: document.menuId,
        brandCode: config.brandCode,
        languageCode: config.languageCode
      }
    })
    await this.syncTaskService.incrementTaskProgress(taskId, {
      processed: 1,
      failed: 1
    })
  }

  private async deleteDocPlatformDocument(
    taskId: string,
    knowledgeBaseId: string,
    document: DocPlatformSyncDocument,
    config: SyncTaskConfig
  ): Promise<void> {
    const docInfo = this.toDocumentInfo(document)
    try {
      const existingDoc = await this.knowledgeBaseService.getDocument(docInfo.id)
      if (!existingDoc) {
        await this.syncTaskService.incrementTaskProgress(taskId, {
          processed: 1,
          skipped: 1
        })
        return
      }

      await this.vectorService.deleteByDocumentId(knowledgeBaseId, docInfo.id)
      await this.knowledgeBaseService.deleteDocument(docInfo.id)
      await this.syncTaskService.incrementTaskProgress(taskId, {
        processed: 1,
        success: 1
      })
    } catch (error: any) {
      const errorClassification = classifyError(error)
      await this.syncTaskService.addFailedDocument(taskId, {
        docId: docInfo.id,
        docName: docInfo.name,
        error: error.message || 'Unknown error',
        retryCount: 0,
        errorType: errorClassification.type,
        failedAt: new Date().toISOString(),
        canRetry: errorClassification.canRetry,
        operation: config.operation,
        context: {
          menuId: document.menuId,
          brandCode: config.brandCode,
          languageCode: config.languageCode
        }
      })
      await this.syncTaskService.incrementTaskProgress(taskId, {
        processed: 1,
        failed: 1
      })
    }
  }

  /**
   * 处理单个文档（带重试）
   */
  private async processDocument(
    taskId: string,
    knowledgeBaseId: string,
    docInfo: DocumentInfo,
    config: SyncTaskConfig
  ): Promise<void> {
    let lastError: any
    let retryCount = 0

    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      try {
        await this.processDocumentOnce(taskId, knowledgeBaseId, docInfo, config)
        // 成功，退出重试循环
        return
      } catch (error: any) {
        lastError = error

        // 检查是否是 404 错误（文档不存在）
        const isNotFoundError = error.message?.includes('HTTP 404') || error.message?.includes('Not Found')
        if (isNotFoundError) {
          console.warn(`[文档同步] 文档 ${docInfo.id} (${docInfo.name}) 不存在（404），跳过处理`)

          // 如果文档已存在于数据库中，标记为需要删除或标记为已删除
          const existingDoc = await this.knowledgeBaseService.getDocument(docInfo.id)
          if (existingDoc) {
            console.log(`[文档同步] 文档 ${docInfo.id} 在数据库中存在但源文档已删除，标记为 failed 状态`)
            // 可选：删除数据库中的文档记录和向量
            // await this.knowledgeBaseService.deleteDocument(docInfo.id)
            // 或者标记为 failed 状态
            await this.knowledgeBaseService.updateDocumentStatus(
              docInfo.id,
              'failed',
              'Source document not found (404)'
            )
          }

          // 标记为跳过
          await this.syncTaskService.incrementTaskProgress(taskId, {
            processed: 1,
            skipped: 1
          })
          return // 跳过，不记录为失败
        }

        // 判断是否可重试
        if (isRetryableError(error) && attempt < this.retryConfig.maxRetries) {
          retryCount++
          const delayMs = this.retryConfig.retryDelay * Math.pow(2, attempt) // 指数退避
          console.warn(
            `Retrying document ${docInfo.id} (${docInfo.name}) after ${delayMs}ms (attempt ${attempt + 1}/${
              this.retryConfig.maxRetries + 1
            })`
          )
          await delay(delayMs)
          continue
        }

        // 不可重试或已达到最大重试次数
        break
      }
    }

    // 处理失败，记录到失败列表
    const errorClassification = classifyError(lastError)
    const failedDoc: FailedDocument = {
      docId: docInfo.id,
      docName: docInfo.name,
      error: lastError?.message || 'Unknown error',
      retryCount,
      errorType: errorClassification.type,
      failedAt: new Date().toISOString(),
      canRetry: errorClassification.canRetry
    }

    await this.syncTaskService.addFailedDocument(taskId, failedDoc)
    await this.syncTaskService.incrementTaskProgress(taskId, {
      processed: 1,
      failed: 1
    })

    console.error(`Failed to process document ${docInfo.id} (${docInfo.name}):`, lastError?.message)
  }

  /**
   * 处理单个文档（单次尝试）
   * 优化：统一使用 documentService 的方法，避免重复删除和向量丢失
   */
  private async processDocumentOnce(
    taskId: string,
    knowledgeBaseId: string,
    docInfo: DocumentInfo,
    config: SyncTaskConfig
  ): Promise<void> {
    // 1. 检查文档是否已存在
    const existingDoc = await this.knowledgeBaseService.getDocument(docInfo.id)

    // 2. 获取文档内容
    const tiptapJson = await this.yddocApiService.getDocumentContent(docInfo.id, config.brandCode, config.languageCode)
    console.log(
      `[文档同步] 文档 ${docInfo.id} (${docInfo.name}) 获取到的 tiptapJson:`,
      JSON.stringify(tiptapJson, null, 2).substring(0, 1000)
    )

    // 检查 tiptapJson 是否有效
    if (!tiptapJson || !tiptapJson.type) {
      throw new Error(`Invalid tiptapJson for document ${docInfo.id}: missing type field or empty content`)
    }

    // 检查是否有内容
    const hasContent = tiptapJson.content && Array.isArray(tiptapJson.content) && tiptapJson.content.length > 0
    if (!hasContent) {
      console.warn(`[文档同步] 文档 ${docInfo.id} (${docInfo.name}) 的 tiptapJson 没有内容节点`)
      // 尝试从其他字段提取内容
      const textContent = extractTextFromTiptap(tiptapJson)
      if (!textContent || textContent.trim().length === 0) {
        throw new Error(`Document ${docInfo.id} (${docInfo.name}) has no content`)
      }
      console.log(`[文档同步] 从 tiptapJson 中提取到文本内容: ${textContent.substring(0, 200)}`)
    }

    await this.processDocumentContentOnce(taskId, knowledgeBaseId, docInfo, config, tiptapJson, existingDoc)
  }

  private async processDocumentContentOnce(
    taskId: string,
    knowledgeBaseId: string,
    docInfo: DocumentInfo,
    config: SyncTaskConfig,
    tiptapJson: any,
    existingDocument?: Awaited<ReturnType<KnowledgeBaseService['getDocument']>>
  ): Promise<void> {
    const existingDoc = existingDocument ?? (await this.knowledgeBaseService.getDocument(docInfo.id))
    const tiptapJsonString = typeof tiptapJson === 'string' ? tiptapJson : JSON.stringify(tiptapJson)
    console.log(
      `[文档同步] 文档 ${docInfo.id} (${docInfo.name}) tiptapJson 序列化完成，长度: ${tiptapJsonString.length} 字符`
    )

    const contentHash = calculateContentHash(tiptapJsonString)

    if (existingDoc) {
      const existingHash = existingDoc.metadata?.contentHash
      console.log(`[文档同步] 文档 ${docInfo.id} (${docInfo.name}) 已存在`)
      console.log(`[文档同步] 现有内容哈希: ${existingHash}`)
      console.log(`[文档同步] 新内容哈希: ${contentHash}`)

      let vectorCountMatches = false
      if (existingDoc.status === 'completed' && existingDoc.chunkCount > 0) {
        try {
          const vectorIds = await this.vectorService.getDocumentVectorIds(knowledgeBaseId, docInfo.id)
          vectorCountMatches = vectorIds.length === existingDoc.chunkCount
        } catch (error: any) {
          console.warn(`[文档同步] 校验文档 ${docInfo.id} 向量数量失败，将重新处理: ${error.message}`)
        }
      }

      if (
        !docInfo.force &&
        existingHash === contentHash &&
        existingDoc.status === 'completed' &&
        existingDoc.chunkCount > 0 &&
        vectorCountMatches
      ) {
        console.log(`[文档同步] 文档 ${docInfo.id} (${docInfo.name}) 内容未变更且向量完整，跳过处理`)
        await this.syncTaskService.incrementTaskProgress(taskId, {
          processed: 1,
          skipped: 1
        })
        return
      } else if (docInfo.force) {
        console.log(`[文档同步] 文档 ${docInfo.id} (${docInfo.name}) 为手动强制同步，将跳过 hash 命中判断`)
      } else {
        console.log(`[文档同步] 文档 ${docInfo.id} (${docInfo.name}) 需要重新处理`)
      }
    } else {
      console.log(`[文档同步] 文档 ${docInfo.id} (${docInfo.name}) 是新文档，将创建`)
    }

    const kb = await this.knowledgeBaseService.getKnowledgeBase(knowledgeBaseId)
    if (!kb) {
      throw new Error(`Knowledge base not found: ${knowledgeBaseId}`)
    }

    const embeddingModel = kb.embeddingModel
    const chunkStrategy = 'markdown' as any // 向量化时使用 markdown 策略
    const chunkConfig = config.chunkConfig || kb.defaultChunkConfig

    console.log(`[文档同步] 存储 tiptapJson，向量化时使用分块策略: ${chunkStrategy}`)

    // 7.1. 构建文档完整地址
    const docUrl = `https://www.yingdao.com/yddoc/${config.brandCode}/${config.languageCode}/${docInfo.id}`

    const previousMetadata = (existingDoc?.metadata || {}) as Record<string, any>
    const {
      contentHash: _oldContentHash,
      pendingContentHash: _oldPendingContentHash,
      syncStatus: _oldSyncStatus,
      syncAttemptAt: _oldSyncAttemptAt,
      error: _oldError,
      errorAt: _oldErrorAt,
      ...preservedMetadata
    } = previousMetadata
    const baseMetadata = {
      ...preservedMetadata,
      ...(docInfo.metadata || {}),
      docName: docInfo.name,
      docPath: docInfo.path, // 完整路径
      parentPath: docInfo.parentPath, // 父级路径
      docUrl, // 文档完整地址
      brandCode: config.brandCode, // 品牌代码
      languageCode: config.languageCode // 语言代码
    }
    const processingMetadata = {
      ...baseMetadata,
      pendingContentHash: contentHash,
      syncStatus: 'processing',
      syncAttemptAt: new Date().toISOString()
    }
    const completedMetadata = {
      ...baseMetadata,
      contentHash,
      syncStatus: 'completed',
      syncedAt: new Date().toISOString()
    }

    if (!existingDoc) {
      // 新文档：先创建记录，再向量化
      try {
        // 8.1 创建文档记录（存储 tiptapJson）
        await this.knowledgeBaseService.createDocument(
          knowledgeBaseId,
          tiptapJsonString,
          'tiptap',
          chunkStrategy as any,
          chunkConfig,
          processingMetadata,
          docInfo.id
        )

        // 8.2 向量化（如果失败，标记为 failed 或删除文档记录）
        // processDocument 会自动将 tiptap 类型转换为 markdown
        try {
          const { chunkCount } = await this.documentService.processDocument(
            knowledgeBaseId,
            tiptapJsonString,
            docInfo.id,
            'tiptap',
            chunkStrategy as any,
            chunkConfig,
            completedMetadata,
            embeddingModel
          )

          await this.knowledgeBaseService.updateDocument(
            docInfo.id,
            tiptapJsonString,
            'tiptap',
            chunkStrategy as any,
            chunkConfig,
            completedMetadata
          )
          await this.knowledgeBaseService.updateDocumentChunkCount(docInfo.id, chunkCount)
          await this.knowledgeBaseService.updateDocumentStatus(docInfo.id, 'completed')
          console.log(`[文档同步] 文档 ${docInfo.id} (${docInfo.name}) 向量化完成，块数量: ${chunkCount}`)
        } catch (vectorError: any) {
          // 向量化失败，标记为 failed 并记录错误
          console.error(`向量化失败，标记文档为 failed: ${docInfo.id}`, vectorError.message)
          await this.knowledgeBaseService.updateDocumentStatus(docInfo.id, 'failed', vectorError.message)
          // 可选：删除文档记录（根据配置决定）
          // await this.knowledgeBaseService.deleteDocument(docInfo.id)
          throw vectorError
        }
      } catch (error: any) {
        throw new Error(`Failed to create document ${docInfo.id}: ${error.message}`)
      }
    } else {
      // 已存在的文档：使用 updateDocumentWithRetry 处理（带重试机制）
      try {
        // 先更新状态为 processing
        await this.knowledgeBaseService.updateDocumentStatus(docInfo.id, 'processing')

        const { chunkCount } = await this.documentService.updateDocumentWithRetry(
          knowledgeBaseId,
          docInfo.id,
          tiptapJsonString,
          'tiptap',
          chunkStrategy as any,
          chunkConfig,
          completedMetadata,
          embeddingModel,
          3 // 最多重试3次
        )

        // 向量处理成功后，再提交 documents 内容和最终 contentHash。
        await this.knowledgeBaseService.updateDocument(
          docInfo.id,
          tiptapJsonString,
          'tiptap',
          chunkStrategy as any,
          chunkConfig,
          completedMetadata
        )

        // 更新文档的块数量和状态为 completed
        await this.knowledgeBaseService.updateDocumentChunkCount(docInfo.id, chunkCount)
        await this.knowledgeBaseService.updateDocumentStatus(docInfo.id, 'completed')
        console.log(`[文档同步] 文档 ${docInfo.id} (${docInfo.name}) 更新完成，块数量: ${chunkCount}`)
      } catch (updateError: any) {
        // 更新失败，标记为 failed
        console.error(`文档更新失败，标记为 failed: ${docInfo.id}`, updateError.message)
        await this.knowledgeBaseService.updateDocumentStatus(docInfo.id, 'failed', updateError.message)
        throw updateError
      }
    }

    // 9. 更新进度
    await this.syncTaskService.incrementTaskProgress(taskId, {
      processed: 1,
      success: 1
    })

    // 10. 如果文档之前在失败列表中，移除它（重试成功）
    try {
      await this.syncTaskService.removeFailedDocument(taskId, docInfo.id)
    } catch (error: any) {
      // 如果移除失败，记录警告但不影响主流程
      console.warn(`Failed to remove document from failed list: ${error.message}`)
    }
  }
}
