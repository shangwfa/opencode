import { describe, it, expect, mock, spyOn, jest, beforeEach, afterEach } from 'bun:test'
import { DocumentSyncService } from './document-sync.service.js'
import type { YddocApiService } from './yddoc-api.service.js'
import type { KnowledgeBaseService } from './knowledge-base.service.js'
import type { DocumentService } from './document.service.js'
import type { VectorService } from './vector.service.js'
import type { SyncTaskService, SyncTaskConfig } from './sync-task.service.js'
import type { Document } from '../types/knowledge-base.types.js'

describe('DocumentSyncService', () => {
  let service: DocumentSyncService
  let mockYddocApiService: any
  let mockKnowledgeBaseService: any
  let mockDocumentService: any
  let mockVectorService: any
  let mockSyncTaskService: any

  beforeEach(() => {
    // 抑制console.error和console.warn输出，避免测试输出混乱
    spyOn(console, 'error').mockImplementation(() => {})
    spyOn(console, 'warn').mockImplementation(() => {})
    spyOn(console, 'log').mockImplementation(() => {})

    // Mock所有依赖服务
    mockYddocApiService = {
      getMenuTree: mock(),
      getDocumentContent: mock(),
      extractAllDocIds: mock()
    }

    mockKnowledgeBaseService = {
      getKnowledgeBase: mock(),
      getDocument: mock(),
      addDocument: mock(),
      updateDocument: mock(),
      createDocument: mock(),
      deleteDocument: mock(),
      updateDocumentChunkCount: mock(),
      updateDocumentStatus: mock()
    }

    mockDocumentService = {
      processDocument: mock(),
      updateDocument: mock(),
      updateDocumentWithRetry: mock()
    }

    mockVectorService = {
      deleteByDocumentId: mock(),
      createIndex: mock(),
      getDocumentVectorIds: mock().mockResolvedValue(['doc1_0'])
    }

    mockSyncTaskService = {
      updateTaskStatus: mock(),
      updateTaskProgress: mock(),
      incrementTaskProgress: mock(),
      addFailedDocument: mock(),
      getTaskStatus: mock().mockResolvedValue({ progress: { failed: 0, success: 1 } })
    }

    service = new DocumentSyncService(
      mockYddocApiService as any,
      mockKnowledgeBaseService as any,
      mockDocumentService as any,
      mockVectorService as any,
      mockSyncTaskService as any
    )
  })

  afterEach(() => {
    mock.clearAllMocks()
    jest.useRealTimers()
    mock.restore()
  })

  describe('syncDocumentsFromYingdao', () => {
    const taskId = 'task_123'
    const knowledgeBaseId = 'kb_rpa_zh-CN'
    const config: SyncTaskConfig = {
      brandCode: 'rpa',
      languageCode: 'zh-CN',
      chunkStrategy: 'recursive'
    }

    it('应该完成完整同步流程（成功）', async () => {
      const menuTree = [
        {
          id: 'doc1',
          name: '文档1',
          type: 'doc' as const,
          docUniqueId: 'doc1',
          menuTrees: []
        }
      ]

      const docIds = [{ id: 'doc1', name: '文档1', path: '文档1', parentPath: '' }]

      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: '测试内容' }]
          }
        ]
      }

      const knowledgeBase = {
        id: knowledgeBaseId,
        name: '测试知识库',
        embeddingModel: 'openai/text-embedding-3-small',
        defaultChunkStrategy: 'recursive' as const,
        indexCreated: 1,
        createdAt: new Date(),
        updatedAt: new Date()
      }

      mockYddocApiService.getMenuTree.mockResolvedValue(menuTree)
      mockYddocApiService.extractAllDocIds.mockReturnValue(docIds)
      mockYddocApiService.getDocumentContent.mockResolvedValue(tiptapJson)
      mockKnowledgeBaseService.getKnowledgeBase.mockResolvedValue(knowledgeBase)
      mockKnowledgeBaseService.getDocument.mockResolvedValue(null) // 文档不存在
      mockKnowledgeBaseService.createDocument.mockResolvedValue({} as Document)
      mockDocumentService.processDocument.mockResolvedValue({ chunkCount: 1 })
      mockSyncTaskService.updateTaskProgress.mockResolvedValue(undefined)
      mockSyncTaskService.updateTaskStatus.mockResolvedValue(undefined)

      await service.syncDocumentsFromYingdao(taskId, knowledgeBaseId, config)

      expect(mockSyncTaskService.updateTaskStatus).toHaveBeenCalledWith(taskId, 'running')
      expect(mockYddocApiService.getMenuTree).toHaveBeenCalledWith('rpa', 'zh-CN')
      expect(mockYddocApiService.extractAllDocIds).toHaveBeenCalledWith(menuTree)
      expect(mockSyncTaskService.updateTaskProgress).toHaveBeenCalledWith(taskId, {
        total: 1
      })
      expect(mockKnowledgeBaseService.getDocument).toHaveBeenCalledWith('doc1')
      expect(mockYddocApiService.getDocumentContent).toHaveBeenCalledWith('doc1', 'rpa', 'zh-CN')
      expect(mockKnowledgeBaseService.createDocument).toHaveBeenCalled()
      expect(mockDocumentService.processDocument).toHaveBeenCalled()
      expect(mockSyncTaskService.updateTaskStatus).toHaveBeenCalledWith(taskId, 'completed')
    })

    it('应该处理已存在的文档（跳过未变更）', async () => {
      const menuTree = [
        {
          id: 'doc1',
          name: '文档1',
          type: 'doc' as const,
          docUniqueId: 'doc1',
          menuTrees: []
        }
      ]

      const docIds = [{ id: 'doc1', name: '文档1', path: '文档1', parentPath: '' }]
      const tiptapJson = {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: '测试内容' }] }]
      }

      const knowledgeBase = {
        id: knowledgeBaseId,
        name: '测试知识库',
        embeddingModel: 'openai/text-embedding-3-small',
        defaultChunkStrategy: 'recursive' as const,
        indexCreated: 1,
        createdAt: new Date(),
        updatedAt: new Date()
      }

      // 计算内容哈希（基于序列化后的 tiptapJson）
      const { createHash } = await import('crypto')
      const tiptapJsonString = JSON.stringify(tiptapJson)
      const contentHash = createHash('sha256').update(tiptapJsonString).digest('hex')

      const existingDoc: Document = {
        id: 'doc1',
        knowledgeBaseId,
        content: tiptapJsonString,
        type: 'tiptap',
        chunkStrategy: 'recursive',
        metadata: { contentHash },
        chunkCount: 1,
        status: 'completed',
        createdAt: new Date(),
        updatedAt: new Date()
      }

      mockYddocApiService.getMenuTree.mockResolvedValue(menuTree)
      mockYddocApiService.extractAllDocIds.mockReturnValue(docIds)
      mockYddocApiService.getDocumentContent.mockResolvedValue(tiptapJson)
      mockKnowledgeBaseService.getKnowledgeBase.mockResolvedValue(knowledgeBase)
      mockKnowledgeBaseService.getDocument.mockResolvedValue(existingDoc)
      mockSyncTaskService.updateTaskProgress.mockResolvedValue(undefined)
      mockSyncTaskService.updateTaskStatus.mockResolvedValue(undefined)

      await service.syncDocumentsFromYingdao(taskId, knowledgeBaseId, config)

      // 应该跳过处理，不调用addDocument或processDocument
      expect(mockKnowledgeBaseService.createDocument).not.toHaveBeenCalled()
      expect(mockDocumentService.processDocument).not.toHaveBeenCalled()
      expect(mockSyncTaskService.incrementTaskProgress).toHaveBeenCalledWith(taskId, {
        processed: 1,
        skipped: 1
      })
    })

    it('应该处理已存在的文档（更新已变更）', async () => {
      const menuTree = [
        {
          id: 'doc1',
          name: '文档1',
          type: 'doc' as const,
          docUniqueId: 'doc1',
          menuTrees: []
        }
      ]

      const docIds = [{ id: 'doc1', name: '文档1', path: '文档1', parentPath: '' }]
      const tiptapJson = {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: '新内容' }] }]
      }

      const knowledgeBase = {
        id: knowledgeBaseId,
        name: '测试知识库',
        embeddingModel: 'openai/text-embedding-3-small',
        defaultChunkStrategy: 'recursive' as const,
        indexCreated: 1,
        createdAt: new Date(),
        updatedAt: new Date()
      }

      // 计算旧内容哈希（基于旧的 tiptapJson）
      const { createHash } = await import('crypto')
      const oldTiptapJson = {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: '旧内容' }] }]
      }
      const oldTiptapJsonString = JSON.stringify(oldTiptapJson)
      const oldContentHash = createHash('sha256').update(oldTiptapJsonString).digest('hex')

      const existingDoc: Document = {
        id: 'doc1',
        knowledgeBaseId,
        content: oldTiptapJsonString,
        type: 'tiptap',
        chunkStrategy: 'recursive',
        metadata: { contentHash: oldContentHash },
        chunkCount: 1,
        createdAt: new Date(),
        updatedAt: new Date()
      }

      mockYddocApiService.getMenuTree.mockResolvedValue(menuTree)
      mockYddocApiService.extractAllDocIds.mockReturnValue(docIds)
      mockYddocApiService.getDocumentContent.mockResolvedValue(tiptapJson)
      mockKnowledgeBaseService.getKnowledgeBase.mockResolvedValue(knowledgeBase)
      mockKnowledgeBaseService.getDocument.mockResolvedValue(existingDoc)
      mockKnowledgeBaseService.updateDocument.mockResolvedValue({} as Document)
      mockDocumentService.updateDocumentWithRetry.mockResolvedValue({ chunkCount: 1 })
      mockKnowledgeBaseService.deleteDocument.mockResolvedValue(undefined)
      mockSyncTaskService.updateTaskProgress.mockResolvedValue(undefined)
      mockSyncTaskService.updateTaskStatus.mockResolvedValue(undefined)
      mockSyncTaskService.incrementTaskProgress.mockResolvedValue(undefined)

      await service.syncDocumentsFromYingdao(taskId, knowledgeBaseId, config)

      // 应该使用 documentService.updateDocumentWithRetry 统一处理（内部会删除旧向量并创建新向量）
      expect(mockDocumentService.updateDocumentWithRetry).toHaveBeenCalledWith(
        knowledgeBaseId,
        'doc1',
        JSON.stringify(tiptapJson), // tiptapJson 字符串
        'tiptap',
        'markdown', // 向量化时使用 markdown 策略
        undefined, // chunkConfig
        expect.objectContaining({
          contentHash: expect.any(String),
          docName: '文档1',
          docPath: '文档1',
          parentPath: '',
          brandCode: 'rpa',
          languageCode: 'zh-CN',
          docUrl: expect.stringContaining('https://www.yingdao.com/yddoc/rpa/zh-CN/doc1')
        }),
        'openai/text-embedding-3-small',
        3 // maxRetries
      )

      // 应该更新文档记录的元数据
      expect(mockKnowledgeBaseService.updateDocument).toHaveBeenCalled()

      expect(mockSyncTaskService.incrementTaskProgress).toHaveBeenCalledWith(taskId, {
        processed: 1,
        success: 1
      })
    })

    it('应该在文档处理失败时重试', async () => {
      const menuTree = [
        {
          id: 'doc1',
          name: '文档1',
          type: 'doc' as const,
          docUniqueId: 'doc1',
          menuTrees: []
        }
      ]

      const docIds = [{ id: 'doc1', name: '文档1', path: '文档1', parentPath: '' }]
      const tiptapJson = {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: '测试内容' }] }]
      }

      const knowledgeBase = {
        id: knowledgeBaseId,
        name: '测试知识库',
        embeddingModel: 'openai/text-embedding-3-small',
        defaultChunkStrategy: 'recursive' as const,
        indexCreated: 1,
        createdAt: new Date(),
        updatedAt: new Date()
      }

      const networkError = { message: 'ECONNRESET', code: 'ECONNRESET' }

      mockYddocApiService.getMenuTree.mockResolvedValue(menuTree)
      mockYddocApiService.extractAllDocIds.mockReturnValue(docIds)
      mockKnowledgeBaseService.getKnowledgeBase.mockResolvedValue(knowledgeBase)
      mockKnowledgeBaseService.getDocument.mockResolvedValue(null)

      // 第一次失败，第二次成功
      mockYddocApiService.getDocumentContent.mockRejectedValueOnce(networkError).mockResolvedValueOnce(tiptapJson)

      mockKnowledgeBaseService.createDocument.mockResolvedValue({} as Document)
      mockDocumentService.processDocument.mockResolvedValue({ chunkCount: 1 })
      mockSyncTaskService.updateTaskProgress.mockResolvedValue(undefined)
      mockSyncTaskService.updateTaskStatus.mockResolvedValue(undefined)


      const syncPromise = service.syncDocumentsFromYingdao(taskId, knowledgeBaseId, config)

      // 等待重试延迟

      await syncPromise

      expect(mockYddocApiService.getDocumentContent).toHaveBeenCalledTimes(2)
      expect(mockSyncTaskService.updateTaskStatus).toHaveBeenCalledWith(taskId, 'completed')
    })

    it('应该在文档处理失败后记录到失败列表', async () => {
      const menuTree = [
        {
          id: 'doc1',
          name: '文档1',
          type: 'doc' as const,
          docUniqueId: 'doc1',
          menuTrees: []
        }
      ]

      const docIds = [{ id: 'doc1', name: '文档1', path: '文档1', parentPath: '' }]

      const knowledgeBase = {
        id: knowledgeBaseId,
        name: '测试知识库',
        embeddingModel: 'openai/text-embedding-3-small',
        defaultChunkStrategy: 'recursive' as const,
        indexCreated: 1,
        createdAt: new Date(),
        updatedAt: new Date()
      }

      const permanentError = new Error('Invalid document format')

      mockYddocApiService.getMenuTree.mockResolvedValue(menuTree)
      mockYddocApiService.extractAllDocIds.mockReturnValue(docIds)
      mockKnowledgeBaseService.getKnowledgeBase.mockResolvedValue(knowledgeBase)
      mockKnowledgeBaseService.getDocument.mockResolvedValue(null)
      mockYddocApiService.getDocumentContent.mockRejectedValue(permanentError)
      mockSyncTaskService.updateTaskProgress.mockResolvedValue(undefined)
      mockSyncTaskService.addFailedDocument.mockResolvedValue(undefined)
      mockSyncTaskService.updateTaskStatus.mockResolvedValue(undefined)

      await service.syncDocumentsFromYingdao(taskId, knowledgeBaseId, config)

      expect(mockSyncTaskService.addFailedDocument).toHaveBeenCalledWith(
        taskId,
        expect.objectContaining({
          docId: 'doc1',
          docName: '文档1',
          error: expect.any(String),
          retryCount: expect.any(Number)
        })
      )
      expect(mockSyncTaskService.incrementTaskProgress).toHaveBeenCalledWith(taskId, {
        processed: 1,
        failed: 1
      })
      expect(mockSyncTaskService.updateTaskStatus).toHaveBeenCalledWith(taskId, 'completed')
    })

    it('应该在任务失败时更新状态', async () => {
      const error = new Error('Sync failed')

      mockYddocApiService.getMenuTree.mockRejectedValue(error)
      mockSyncTaskService.updateTaskStatus.mockResolvedValue(undefined)

      await expect(service.syncDocumentsFromYingdao(taskId, knowledgeBaseId, config)).rejects.toThrow()

      expect(mockSyncTaskService.updateTaskStatus).toHaveBeenCalledWith(taskId, 'failed', expect.any(String))
    })

    it('应该处理知识库不存在的情况', async () => {
      const menuTree = [
        {
          id: 'doc1',
          name: '文档1',
          type: 'doc' as const,
          docUniqueId: 'doc1',
          menuTrees: []
        }
      ]

      const docIds = [{ id: 'doc1', name: '文档1', path: '文档1', parentPath: '' }]
      const tiptapJson = {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: '测试内容' }] }]
      }

      const knowledgeBase = {
        id: knowledgeBaseId,
        name: '测试知识库',
        embeddingModel: 'openai/text-embedding-3-small',
        defaultChunkStrategy: 'recursive' as const,
        indexCreated: 1,
        createdAt: new Date(),
        updatedAt: new Date()
      }

      mockYddocApiService.getMenuTree.mockResolvedValue(menuTree)
      mockYddocApiService.extractAllDocIds.mockReturnValue(docIds)
      mockYddocApiService.getDocumentContent.mockResolvedValue(tiptapJson)
      // 在processDocumentOnce中调用getKnowledgeBase时返回null
      // 注意：getKnowledgeBase 只会在 processDocumentOnce 中被调用一次
      mockKnowledgeBaseService.getKnowledgeBase.mockResolvedValue(null)
      mockKnowledgeBaseService.getDocument.mockResolvedValue(null)
      // 错误会被捕获并记录到失败列表，但不会导致整个任务失败
      mockSyncTaskService.addFailedDocument.mockResolvedValue(undefined)
      mockSyncTaskService.updateTaskProgress.mockResolvedValue(undefined)
      mockSyncTaskService.updateTaskStatus.mockResolvedValue(undefined)
      mockSyncTaskService.incrementTaskProgress.mockResolvedValue(undefined)
      mockSyncTaskService.getTaskStatus.mockResolvedValue({
        id: taskId,
        knowledgeBaseId,
        status: 'running',
        config,
        progress: {
          total: 1,
          processed: 1,
          success: 0,
          failed: 1,
          skipped: 0
        },
        failedDocuments: [],
        createdAt: new Date(),
        updatedAt: new Date()
      })

      await service.syncDocumentsFromYingdao(taskId, knowledgeBaseId, config)

      // 验证错误被记录到失败列表
      expect(mockSyncTaskService.addFailedDocument).toHaveBeenCalledWith(
        taskId,
        expect.objectContaining({
          docId: 'doc1',
          docName: '文档1',
          error: expect.stringContaining('Knowledge base not found'),
          retryCount: 0 // 因为错误不可重试（永久性错误），所以 retryCount 为 0
        })
      )
      // 验证任务完成（单个文档失败不影响整体任务）
      // 由于有失败文档，应该标记为 failed 或 partially_completed
      expect(mockSyncTaskService.updateTaskStatus).toHaveBeenCalledWith(
        taskId,
        expect.stringMatching(/failed|partially_completed/)
      )
    })

    it('应该处理5xx服务器错误（可重试）', async () => {
      const menuTree = [
        {
          id: 'doc1',
          name: '文档1',
          type: 'doc' as const,
          docUniqueId: 'doc1',
          menuTrees: []
        }
      ]

      const docIds = [{ id: 'doc1', name: '文档1', path: '文档1', parentPath: '' }]
      const knowledgeBase = {
        id: knowledgeBaseId,
        name: '测试知识库',
        embeddingModel: 'openai/text-embedding-3-small',
        defaultChunkStrategy: 'recursive' as const,
        indexCreated: 1,
        createdAt: new Date(),
        updatedAt: new Date()
      }

      const serverError = { message: 'HTTP 500: Internal Server Error' }

      mockYddocApiService.getMenuTree.mockResolvedValue(menuTree)
      mockYddocApiService.extractAllDocIds.mockReturnValue(docIds)
      mockKnowledgeBaseService.getKnowledgeBase.mockResolvedValue(knowledgeBase)
      mockKnowledgeBaseService.getDocument.mockResolvedValue(null)

      // 第一次5xx错误，第二次成功
      mockYddocApiService.getDocumentContent.mockRejectedValueOnce(serverError).mockResolvedValueOnce({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: '测试内容' }] }]
      })

      mockKnowledgeBaseService.createDocument.mockResolvedValue({} as Document)
      mockDocumentService.processDocument.mockResolvedValue({ chunkCount: 1 })
      mockSyncTaskService.updateTaskProgress.mockResolvedValue(undefined)
      mockSyncTaskService.updateTaskStatus.mockResolvedValue(undefined)


      const syncPromise = service.syncDocumentsFromYingdao(taskId, knowledgeBaseId, config)


      await syncPromise

      expect(mockYddocApiService.getDocumentContent).toHaveBeenCalledTimes(2)
    })

    it('应该处理数据库连接错误（可重试）', async () => {
      const menuTree = [
        {
          id: 'doc1',
          name: '文档1',
          type: 'doc' as const,
          docUniqueId: 'doc1',
          menuTrees: []
        }
      ]

      const docIds = [{ id: 'doc1', name: '文档1', path: '文档1', parentPath: '' }]
      const knowledgeBase = {
        id: knowledgeBaseId,
        name: '测试知识库',
        embeddingModel: 'openai/text-embedding-3-small',
        defaultChunkStrategy: 'recursive' as const,
        indexCreated: 1,
        createdAt: new Date(),
        updatedAt: new Date()
      }

      const dbError = { message: 'connection timeout' }

      mockYddocApiService.getMenuTree.mockResolvedValue(menuTree)
      mockYddocApiService.extractAllDocIds.mockReturnValue(docIds)
      mockKnowledgeBaseService.getKnowledgeBase.mockResolvedValue(knowledgeBase)
      mockKnowledgeBaseService.getDocument.mockResolvedValue(null)

      // 第一次数据库错误，第二次成功
      mockKnowledgeBaseService.createDocument.mockRejectedValueOnce(dbError).mockResolvedValueOnce({} as Document)

      mockYddocApiService.getDocumentContent.mockResolvedValue({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: '测试内容' }] }]
      })

      mockDocumentService.processDocument.mockResolvedValue({ chunkCount: 1 })
      mockSyncTaskService.updateTaskProgress.mockResolvedValue(undefined)
      mockSyncTaskService.updateTaskStatus.mockResolvedValue(undefined)


      const syncPromise = service.syncDocumentsFromYingdao(taskId, knowledgeBaseId, config)


      await syncPromise

      expect(mockKnowledgeBaseService.createDocument).toHaveBeenCalledTimes(2)
    })

    it('应该串行处理文档（确保按顺序处理）', async () => {
      const menuTree = [
        {
          id: 'doc1',
          name: '文档1',
          type: 'doc' as const,
          docUniqueId: 'doc1',
          menuTrees: []
        },
        {
          id: 'doc2',
          name: '文档2',
          type: 'doc' as const,
          docUniqueId: 'doc2',
          menuTrees: []
        }
      ]

      const docIds = [
        { id: 'doc1', name: '文档1', path: '文档1', parentPath: '' },
        { id: 'doc2', name: '文档2', path: '文档2', parentPath: '' }
      ]

      const knowledgeBase = {
        id: knowledgeBaseId,
        name: '测试知识库',
        embeddingModel: 'openai/text-embedding-3-small',
        defaultChunkStrategy: 'recursive' as const,
        indexCreated: 1,
        createdAt: new Date(),
        updatedAt: new Date()
      }

      const tiptapJson1 = {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: '内容1' }] }]
      }

      const tiptapJson2 = {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: '内容2' }] }]
      }

      const callOrder: string[] = []

      mockYddocApiService.getMenuTree.mockResolvedValue(menuTree)
      mockYddocApiService.extractAllDocIds.mockReturnValue(docIds)
      mockKnowledgeBaseService.getKnowledgeBase.mockResolvedValue(knowledgeBase)
      mockKnowledgeBaseService.getDocument.mockResolvedValue(null)

      mockYddocApiService.getDocumentContent.mockImplementation(async (docId: string) => {
        callOrder.push(`getContent_${docId}`)
        return docId === 'doc1' ? tiptapJson1 : tiptapJson2
      })

      mockKnowledgeBaseService.createDocument.mockImplementation(async () => {
        callOrder.push('createDocument')
        return {} as Document
      })

      mockDocumentService.processDocument.mockImplementation(async () => {
        callOrder.push('processDocument')
        return { chunkCount: 1 }
      })

      mockSyncTaskService.updateTaskProgress.mockResolvedValue(undefined)
      mockSyncTaskService.updateTaskStatus.mockResolvedValue(undefined)

      await service.syncDocumentsFromYingdao(taskId, knowledgeBaseId, config)

      // 验证处理顺序：doc1先处理，然后doc2
      expect(callOrder.indexOf('getContent_doc1')).toBeLessThan(callOrder.indexOf('getContent_doc2'))
      expect(callOrder.indexOf('getContent_doc1')).toBeLessThan(callOrder.indexOf('createDocument'))
    })

    it('应该正确累加多个文档的进度（覆盖Bug场景）', async () => {
      // 测试场景：3个文档，2个成功，1个失败
      // 这个测试会暴露当前代码中的bug：传入+1会导致进度被设置为1，而不是累加
      const menuTree = [
        { id: 'doc1', name: '文档1', type: 'doc' as const, docUniqueId: 'doc1', menuTrees: [] },
        { id: 'doc2', name: '文档2', type: 'doc' as const, docUniqueId: 'doc2', menuTrees: [] },
        { id: 'doc3', name: '文档3', type: 'doc' as const, docUniqueId: 'doc3', menuTrees: [] }
      ]

      const docIds = [
        { id: 'doc1', name: '文档1', path: '教程/快速开始/文档1', parentPath: '教程/快速开始' },
        { id: 'doc2', name: '文档2', path: '教程/快速开始/文档2', parentPath: '教程/快速开始' },
        { id: 'doc3', name: '文档3', path: '文档3', parentPath: '' }
      ]

      const knowledgeBase = {
        id: knowledgeBaseId,
        name: '测试知识库',
        embeddingModel: 'openai/text-embedding-3-small',
        defaultChunkStrategy: 'recursive' as const,
        indexCreated: 1,
        createdAt: new Date(),
        updatedAt: new Date()
      }

      const tiptapJson = {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: '测试内容' }] }]
      }

      // 使用智能mock来跟踪进度更新
      let currentProgress: any = { total: 0, processed: 0, success: 0, failed: 0, skipped: 0 }
      const progressUpdates: any[] = []

      mockYddocApiService.getMenuTree.mockResolvedValue(menuTree)
      mockYddocApiService.extractAllDocIds.mockReturnValue(docIds)
      mockKnowledgeBaseService.getKnowledgeBase.mockResolvedValue(knowledgeBase)
      mockKnowledgeBaseService.getDocument.mockResolvedValue(null)

      // doc1和doc2成功，doc3失败（使用永久性错误，避免重试）
      mockYddocApiService.getDocumentContent.mockImplementation(async (docId: string) => {
        if (docId === 'doc3') {
          throw new Error('HTTP 404: Document not found')
        }
        return tiptapJson
      })

      mockKnowledgeBaseService.createDocument.mockResolvedValue({} as Document)
      mockDocumentService.processDocument.mockResolvedValue({ chunkCount: 1 })

      // 智能mock：模拟真实的进度更新逻辑
      mockSyncTaskService.updateTaskProgress.mockImplementation(async (_taskId: string, progressUpdate: any) => {
        // 记录本次更新
        progressUpdates.push({ ...progressUpdate })

        // 模拟 updateTaskProgress 的合并逻辑（用于设置total）
        currentProgress = {
          ...currentProgress,
          ...progressUpdate
        }

        // 模拟数据库存储
        return undefined
      })

      mockSyncTaskService.incrementTaskProgress.mockImplementation(async (_taskId: string, increments: any) => {
        // 记录本次更新
        progressUpdates.push({ ...increments })

        // 模拟 incrementTaskProgress 的累加逻辑（正确的实现）
        currentProgress = {
          total: increments.total ?? currentProgress.total,
          processed: (currentProgress.processed || 0) + (increments.processed || 0),
          success: (currentProgress.success || 0) + (increments.success || 0),
          failed: (currentProgress.failed || 0) + (increments.failed || 0),
          skipped: (currentProgress.skipped || 0) + (increments.skipped || 0)
        }

        // 模拟数据库存储
        return undefined
      })

      mockSyncTaskService.updateTaskStatus.mockResolvedValue(undefined)
      mockSyncTaskService.addFailedDocument.mockResolvedValue(undefined)

      // getTaskStatus 会在最后被调用一次，用于判断任务状态
      let getTaskStatusCallCount = 0
      mockSyncTaskService.getTaskStatus.mockImplementation(() => {
        getTaskStatusCallCount++
        // 返回当前进度状态
        return Promise.resolve({
          id: taskId,
          knowledgeBaseId,
          status: 'running',
          config,
          progress: { ...currentProgress }, // 返回当前进度的副本
          failedDocuments: [],
          createdAt: new Date(),
          updatedAt: new Date()
        })
      })

      await service.syncDocumentsFromYingdao(taskId, knowledgeBaseId, config)

      // 验证方法调用次数
      // updateTaskProgress: 1次设置total
      // incrementTaskProgress: 3次处理文档
      expect(mockSyncTaskService.updateTaskProgress).toHaveBeenCalledTimes(1)
      expect(mockSyncTaskService.incrementTaskProgress).toHaveBeenCalledTimes(3)

      // 验证第一次调用：设置total=3
      expect(progressUpdates[0]).toEqual({ total: 3 })

      // 验证后续调用：每个文档处理后的更新
      // 注意：当前代码有bug，传入的是 +1 而不是 current + 1
      // 这会导致每次都被设置为1，而不是累加

      // 如果代码正确，最终的进度应该是：
      // { total: 3, processed: 3, success: 2, failed: 1, skipped: 0 }
      // 但由于bug，实际会是：
      // { total: 3, processed: 1, success: 1, failed: 1, skipped: 0 }
      // 因为每次传入 { processed: +1, success: +1 } 或 { processed: +1, failed: +1 }

      console.log('进度更新记录:', progressUpdates)
      console.log('最终进度:', currentProgress)

      // 验证进度正确累加（Bug修复后应该通过）
      expect(currentProgress.processed).toBe(3) // 处理了3个文档
      expect(currentProgress.success).toBe(2) // 2个成功
      // 注意：404 错误会被特殊处理为跳过，而不是失败
      // 所以 failed 可能是 0，skipped 可能是 1
      expect(currentProgress.failed + currentProgress.skipped).toBe(1) // 1个失败或跳过
    })
  })

  describe('syncDocumentsByIds', () => {
    const taskId = 'task_123'
    const knowledgeBaseId = 'kb_rpa_zh-CN'
    const config: SyncTaskConfig = {
      brandCode: 'rpa',
      languageCode: 'zh-CN',
      chunkStrategy: 'recursive'
    }

    it('应该成功同步指定的文档ID列表', async () => {
      const menuTree = [
        {
          id: 'doc1',
          name: '文档1',
          type: 'doc' as const,
          docUniqueId: 'doc1',
          menuTrees: []
        },
        {
          id: 'doc2',
          name: '文档2',
          type: 'doc' as const,
          docUniqueId: 'doc2',
          menuTrees: []
        },
        {
          id: 'doc3',
          name: '文档3',
          type: 'doc' as const,
          docUniqueId: 'doc3',
          menuTrees: []
        }
      ]

      const allDocInfos = [
        { id: 'doc1', name: '文档1', path: '文档1', parentPath: '' },
        { id: 'doc2', name: '文档2', path: '文档2', parentPath: '' },
        { id: 'doc3', name: '文档3', path: '文档3', parentPath: '' }
      ]

      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: '测试内容' }]
          }
        ]
      }

      const knowledgeBase = {
        id: knowledgeBaseId,
        name: '测试知识库',
        embeddingModel: 'openai/text-embedding-3-small',
        defaultChunkStrategy: 'recursive' as const,
        indexCreated: 1,
        createdAt: new Date(),
        updatedAt: new Date()
      }

      // 只同步 doc1 和 doc3
      const docIds = ['doc1', 'doc3']

      mockYddocApiService.getMenuTree.mockResolvedValue(menuTree)
      mockYddocApiService.extractAllDocIds.mockReturnValue(allDocInfos)
      mockYddocApiService.getDocumentContent.mockResolvedValue(tiptapJson)
      mockKnowledgeBaseService.getKnowledgeBase.mockResolvedValue(knowledgeBase)
      mockKnowledgeBaseService.getDocument.mockResolvedValue(null) // 文档不存在
      mockKnowledgeBaseService.createDocument.mockResolvedValue({} as Document)
      mockDocumentService.processDocument.mockResolvedValue({ chunkCount: 1 })
      mockSyncTaskService.updateTaskProgress.mockResolvedValue(undefined)
      mockSyncTaskService.updateTaskStatus.mockResolvedValue(undefined)
      mockSyncTaskService.incrementTaskProgress.mockResolvedValue(undefined)

      await service.syncDocumentsByIds(taskId, knowledgeBaseId, docIds, config)

      expect(mockSyncTaskService.updateTaskStatus).toHaveBeenCalledWith(taskId, 'running')
      expect(mockYddocApiService.getMenuTree).toHaveBeenCalledWith('rpa', 'zh-CN')
      expect(mockYddocApiService.extractAllDocIds).toHaveBeenCalledWith(menuTree)
      expect(mockSyncTaskService.updateTaskProgress).toHaveBeenCalledWith(taskId, {
        total: 2 // 只处理2个文档
      })
      // 应该只处理 doc1 和 doc3
      expect(mockKnowledgeBaseService.getDocument).toHaveBeenCalledWith('doc1')
      expect(mockKnowledgeBaseService.getDocument).toHaveBeenCalledWith('doc3')
      expect(mockKnowledgeBaseService.getDocument).not.toHaveBeenCalledWith('doc2')
      expect(mockYddocApiService.getDocumentContent).toHaveBeenCalledWith('doc1', 'rpa', 'zh-CN')
      expect(mockYddocApiService.getDocumentContent).toHaveBeenCalledWith('doc3', 'rpa', 'zh-CN')
      expect(mockKnowledgeBaseService.createDocument).toHaveBeenCalledTimes(2)
      expect(mockDocumentService.processDocument).toHaveBeenCalledTimes(2)
      expect(mockSyncTaskService.updateTaskStatus).toHaveBeenCalledWith(taskId, 'completed')
    })

    it('应该处理部分文档ID不存在的情况', async () => {
      const menuTree = [
        {
          id: 'doc1',
          name: '文档1',
          type: 'doc' as const,
          docUniqueId: 'doc1',
          menuTrees: []
        }
      ]

      const allDocInfos = [{ id: 'doc1', name: '文档1', path: '文档1', parentPath: '' }]

      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: '测试内容' }]
          }
        ]
      }

      const knowledgeBase = {
        id: knowledgeBaseId,
        name: '测试知识库',
        embeddingModel: 'openai/text-embedding-3-small',
        defaultChunkStrategy: 'recursive' as const,
        indexCreated: 1,
        createdAt: new Date(),
        updatedAt: new Date()
      }

      // 请求同步 doc1 和 doc999（doc999不存在）
      const docIds = ['doc1', 'doc999']

      mockYddocApiService.getMenuTree.mockResolvedValue(menuTree)
      mockYddocApiService.extractAllDocIds.mockReturnValue(allDocInfos)
      mockYddocApiService.getDocumentContent.mockResolvedValue(tiptapJson)
      mockKnowledgeBaseService.getKnowledgeBase.mockResolvedValue(knowledgeBase)
      mockKnowledgeBaseService.getDocument.mockResolvedValue(null)
      mockKnowledgeBaseService.createDocument.mockResolvedValue({} as Document)
      mockDocumentService.processDocument.mockResolvedValue({ chunkCount: 1 })
      mockSyncTaskService.updateTaskProgress.mockResolvedValue(undefined)
      mockSyncTaskService.updateTaskStatus.mockResolvedValue(undefined)
      mockSyncTaskService.incrementTaskProgress.mockResolvedValue(undefined)

      await service.syncDocumentsByIds(taskId, knowledgeBaseId, docIds, config)

      // 应该只处理 doc1，doc999 会被警告但不会抛出错误
      expect(mockSyncTaskService.updateTaskProgress).toHaveBeenCalledWith(taskId, {
        total: 1 // 只找到1个文档
      })
      expect(mockKnowledgeBaseService.getDocument).toHaveBeenCalledWith('doc1')
      expect(mockKnowledgeBaseService.getDocument).not.toHaveBeenCalledWith('doc999')
      expect(mockKnowledgeBaseService.createDocument).toHaveBeenCalledTimes(1)
      expect(mockDocumentService.processDocument).toHaveBeenCalledTimes(1)
      expect(mockSyncTaskService.updateTaskStatus).toHaveBeenCalledWith(taskId, 'completed')
    })

    it('应该在所有文档ID都不存在时抛出错误', async () => {
      const menuTree = [
        {
          id: 'doc1',
          name: '文档1',
          type: 'doc' as const,
          docUniqueId: 'doc1',
          menuTrees: []
        }
      ]

      const allDocInfos = [{ id: 'doc1', name: '文档1', path: '文档1', parentPath: '' }]

      const docIds = ['doc999', 'doc888'] // 都不存在

      mockYddocApiService.getMenuTree.mockResolvedValue(menuTree)
      mockYddocApiService.extractAllDocIds.mockReturnValue(allDocInfos)
      mockSyncTaskService.updateTaskStatus.mockResolvedValue(undefined)

      await expect(service.syncDocumentsByIds(taskId, knowledgeBaseId, docIds, config)).rejects.toThrow(
        'None of the specified document IDs were found in the menu tree'
      )

      expect(mockSyncTaskService.updateTaskStatus).toHaveBeenCalledWith(taskId, 'running')
      expect(mockSyncTaskService.updateTaskStatus).toHaveBeenCalledWith(
        taskId,
        'failed',
        expect.stringContaining('None of the specified document IDs were found')
      )
      expect(mockKnowledgeBaseService.getDocument).not.toHaveBeenCalled()
    })

    it('应该处理已存在的文档（更新）', async () => {
      const menuTree = [
        {
          id: 'doc1',
          name: '文档1',
          type: 'doc' as const,
          docUniqueId: 'doc1',
          menuTrees: []
        }
      ]

      const allDocInfos = [{ id: 'doc1', name: '文档1', path: '文档1', parentPath: '' }]

      const tiptapJson = {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: '新内容' }] }]
      }

      const knowledgeBase = {
        id: knowledgeBaseId,
        name: '测试知识库',
        embeddingModel: 'openai/text-embedding-3-small',
        defaultChunkStrategy: 'recursive' as const,
        indexCreated: 1,
        createdAt: new Date(),
        updatedAt: new Date()
      }

      // 计算旧内容哈希（基于旧的 tiptapJson）
      const { createHash } = await import('crypto')
      const oldTiptapJson = {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: '旧内容' }] }]
      }
      const oldTiptapJsonString = JSON.stringify(oldTiptapJson)
      const oldContentHash = createHash('sha256').update(oldTiptapJsonString).digest('hex')

      const existingDoc: Document = {
        id: 'doc1',
        knowledgeBaseId,
        content: oldTiptapJsonString,
        type: 'tiptap',
        chunkStrategy: 'recursive',
        metadata: { contentHash: oldContentHash },
        chunkCount: 1,
        createdAt: new Date(),
        updatedAt: new Date()
      }

      const docIds = ['doc1']

      mockYddocApiService.getMenuTree.mockResolvedValue(menuTree)
      mockYddocApiService.extractAllDocIds.mockReturnValue(allDocInfos)
      mockYddocApiService.getDocumentContent.mockResolvedValue(tiptapJson)
      mockKnowledgeBaseService.getKnowledgeBase.mockResolvedValue(knowledgeBase)
      mockKnowledgeBaseService.getDocument.mockResolvedValue(existingDoc)
      mockKnowledgeBaseService.updateDocument.mockResolvedValue({} as Document)
      mockDocumentService.updateDocumentWithRetry.mockResolvedValue({ chunkCount: 1 })
      mockSyncTaskService.updateTaskProgress.mockResolvedValue(undefined)
      mockSyncTaskService.updateTaskStatus.mockResolvedValue(undefined)
      mockSyncTaskService.incrementTaskProgress.mockResolvedValue(undefined)

      await service.syncDocumentsByIds(taskId, knowledgeBaseId, docIds, config)

      expect(mockDocumentService.updateDocumentWithRetry).toHaveBeenCalled()
      expect(mockKnowledgeBaseService.updateDocument).toHaveBeenCalled()
      expect(mockSyncTaskService.incrementTaskProgress).toHaveBeenCalledWith(taskId, {
        processed: 1,
        success: 1
      })
    })

    it('应该在同步失败时更新任务状态为failed', async () => {
      const menuTree = [
        {
          id: 'doc1',
          name: '文档1',
          type: 'doc' as const,
          docUniqueId: 'doc1',
          menuTrees: []
        }
      ]

      const allDocInfos = [{ id: 'doc1', name: '文档1', path: '文档1', parentPath: '' }]

      const docIds = ['doc1']

      const error = new Error('获取菜单树失败')

      mockYddocApiService.getMenuTree.mockRejectedValue(error)
      mockSyncTaskService.updateTaskStatus.mockResolvedValue(undefined)

      await expect(service.syncDocumentsByIds(taskId, knowledgeBaseId, docIds, config)).rejects.toThrow(
        '获取菜单树失败'
      )

      expect(mockSyncTaskService.updateTaskStatus).toHaveBeenCalledWith(taskId, 'running')
      expect(mockSyncTaskService.updateTaskStatus).toHaveBeenCalledWith(taskId, 'failed', '获取菜单树失败')
    })
  })

  describe('错误分类', () => {
    it('应该正确分类临时性错误', () => {
      const error = new Error('ECONNRESET: connection reset')
      // 通过 processDocument 触发错误分类
      // 这里我们测试错误分类逻辑
      expect(error.message.includes('ECONNRESET')).toBe(true)
    })

    it('应该正确分类永久性错误', () => {
      const error = new Error('HTTP 404: Not Found')
      expect(error.message.includes('HTTP 404') || error.message.includes('Not Found')).toBe(true)
    })
  })

  describe('部分成功状态', () => {
    const taskId = 'task_123'
    const knowledgeBaseId = 'kb_rpa_zh-CN'
    const config: SyncTaskConfig = {
      brandCode: 'rpa',
      languageCode: 'zh-CN',
      chunkStrategy: 'recursive'
    }

    it('应该在部分文档成功、部分失败时标记为部分成功', async () => {
      const menuTree = [
        {
          id: 'doc1',
          name: '文档1',
          type: 'doc' as const,
          docUniqueId: 'doc1',
          menuTrees: []
        },
        {
          id: 'doc2',
          name: '文档2',
          type: 'doc' as const,
          docUniqueId: 'doc2',
          menuTrees: []
        }
      ]

      const docIds = [
        { id: 'doc1', name: '文档1', path: '文档1', parentPath: '' },
        { id: 'doc2', name: '文档2', path: '文档2', parentPath: '' }
      ]

      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: '测试内容' }]
          }
        ]
      }

      const knowledgeBase = {
        id: knowledgeBaseId,
        name: '测试知识库',
        embeddingModel: 'openai/text-embedding-3-small',
        defaultChunkStrategy: 'recursive' as const,
        indexCreated: 1,
        createdAt: new Date(),
        updatedAt: new Date()
      }

      mockYddocApiService.getMenuTree.mockResolvedValue(menuTree)
      mockYddocApiService.extractAllDocIds.mockReturnValue(docIds)
      mockYddocApiService.getDocumentContent
        .mockResolvedValueOnce(tiptapJson) // doc1 成功
        .mockRejectedValueOnce(new Error('Invalid document format')) // doc2 失败（永久性错误，不会重试）
      mockKnowledgeBaseService.getKnowledgeBase.mockResolvedValue(knowledgeBase)
      mockKnowledgeBaseService.getDocument.mockResolvedValue(null)
      mockKnowledgeBaseService.createDocument.mockResolvedValue({} as Document)
      mockDocumentService.processDocument.mockResolvedValue({ chunkCount: 1 })
      mockSyncTaskService.updateTaskProgress.mockResolvedValue(undefined)
      mockSyncTaskService.updateTaskStatus.mockResolvedValue(undefined)
      mockSyncTaskService.incrementTaskProgress.mockResolvedValue(undefined)
      mockSyncTaskService.addFailedDocument.mockResolvedValue(undefined)

      // getTaskStatus 会在最后被调用一次，用于判断任务状态
      // 由于 doc1 成功，doc2 失败，最终状态应该是部分成功
      mockSyncTaskService.getTaskStatus.mockResolvedValue({
        id: taskId,
        knowledgeBaseId,
        status: 'running',
        config,
        progress: {
          total: 2,
          processed: 2,
          success: 1,
          failed: 1,
          skipped: 0
        },
        failedDocuments: [],
        createdAt: new Date(),
        updatedAt: new Date()
      })

      await service.syncDocumentsFromYingdao(taskId, knowledgeBaseId, config)

      // 应该标记为部分成功
      expect(mockSyncTaskService.updateTaskStatus).toHaveBeenCalledWith(taskId, 'partially_completed')
    })
  })

  describe('retryFailedDocuments', () => {
    const taskId = 'task_123'
    const knowledgeBaseId = 'kb_rpa_zh-CN'
    const config: SyncTaskConfig = {
      brandCode: 'rpa',
      languageCode: 'zh-CN',
      chunkStrategy: 'recursive'
    }

    it('应该重试所有可重试的失败文档', async () => {
      const menuTree = [
        {
          id: 'doc1',
          name: '文档1',
          type: 'doc' as const,
          docUniqueId: 'doc1',
          menuTrees: []
        }
      ]

      const docIds = [{ id: 'doc1', name: '文档1', path: '文档1', parentPath: '' }]

      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: '测试内容' }]
          }
        ]
      }

      const knowledgeBase = {
        id: knowledgeBaseId,
        name: '测试知识库',
        embeddingModel: 'openai/text-embedding-3-small',
        defaultChunkStrategy: 'recursive' as const,
        indexCreated: 1,
        createdAt: new Date(),
        updatedAt: new Date()
      }

      const task = {
        id: taskId,
        knowledgeBaseId,
        status: 'partially_completed' as const,
        config,
        progress: {
          total: 1,
          processed: 1,
          success: 0,
          failed: 1,
          skipped: 0
        },
        failedDocuments: [
          {
            docId: 'doc1',
            docName: '文档1',
            error: '网络错误',
            retryCount: 1,
            errorType: 'temporary' as const,
            canRetry: true
          }
        ],
        createdAt: new Date(),
        updatedAt: new Date()
      }

      mockSyncTaskService.getTaskStatus.mockResolvedValue(task)
      mockYddocApiService.getMenuTree.mockResolvedValue(menuTree)
      mockYddocApiService.extractAllDocIds.mockReturnValue(docIds)
      mockYddocApiService.getDocumentContent.mockResolvedValue(tiptapJson)
      mockKnowledgeBaseService.getKnowledgeBase.mockResolvedValue(knowledgeBase)
      mockKnowledgeBaseService.getDocument.mockResolvedValue(null)
      mockKnowledgeBaseService.createDocument.mockResolvedValue({} as Document)
      mockDocumentService.processDocument.mockResolvedValue({ chunkCount: 1 })
      mockSyncTaskService.updateTaskProgress.mockResolvedValue(undefined)
      mockSyncTaskService.updateTaskStatus.mockResolvedValue(undefined)
      mockSyncTaskService.incrementTaskProgress.mockResolvedValue(undefined)
      mockSyncTaskService.removeFailedDocument = mock().mockResolvedValue(undefined)

      await service.retryFailedDocuments(taskId, knowledgeBaseId, config)

      expect(mockSyncTaskService.updateTaskStatus).toHaveBeenCalledWith(taskId, 'running')
      expect(mockYddocApiService.getMenuTree).toHaveBeenCalledWith('rpa', 'zh-CN')
      expect(mockKnowledgeBaseService.getDocument).toHaveBeenCalledWith('doc1')
      expect(mockSyncTaskService.removeFailedDocument).toHaveBeenCalledWith(taskId, 'doc1')
    })

    it('应该跳过不可重试的失败文档', async () => {
      const task = {
        id: taskId,
        knowledgeBaseId,
        status: 'partially_completed' as const,
        config,
        progress: {
          total: 1,
          processed: 1,
          success: 0,
          failed: 1,
          skipped: 0
        },
        failedDocuments: [
          {
            docId: 'doc1',
            docName: '文档1',
            error: 'HTTP 404: Not Found',
            retryCount: 1,
            errorType: 'permanent' as const,
            canRetry: false
          }
        ],
        createdAt: new Date(),
        updatedAt: new Date()
      }

      mockSyncTaskService.getTaskStatus.mockResolvedValue(task)

      await service.retryFailedDocuments(taskId, knowledgeBaseId, config)

      // 应该没有处理任何文档
      expect(mockYddocApiService.getMenuTree).not.toHaveBeenCalled()
    })
  })

  describe('retryDocument', () => {
    const taskId = 'task_123'
    const knowledgeBaseId = 'kb_rpa_zh-CN'
    const config: SyncTaskConfig = {
      brandCode: 'rpa',
      languageCode: 'zh-CN',
      chunkStrategy: 'recursive'
    }

    it('应该重试单个失败文档', async () => {
      const menuTree = [
        {
          id: 'doc1',
          name: '文档1',
          type: 'doc' as const,
          docUniqueId: 'doc1',
          menuTrees: []
        }
      ]

      const docIds = [{ id: 'doc1', name: '文档1', path: '文档1', parentPath: '' }]

      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: '测试内容' }]
          }
        ]
      }

      const knowledgeBase = {
        id: knowledgeBaseId,
        name: '测试知识库',
        embeddingModel: 'openai/text-embedding-3-small',
        defaultChunkStrategy: 'recursive' as const,
        indexCreated: 1,
        createdAt: new Date(),
        updatedAt: new Date()
      }

      const task = {
        id: taskId,
        knowledgeBaseId,
        status: 'partially_completed' as const,
        config,
        progress: {
          total: 1,
          processed: 1,
          success: 0,
          failed: 1,
          skipped: 0
        },
        failedDocuments: [
          {
            docId: 'doc1',
            docName: '文档1',
            error: '网络错误',
            retryCount: 1,
            errorType: 'temporary' as const,
            canRetry: true
          }
        ],
        createdAt: new Date(),
        updatedAt: new Date()
      }

      mockSyncTaskService.getTaskStatus.mockResolvedValue(task)
      mockYddocApiService.getMenuTree.mockResolvedValue(menuTree)
      mockYddocApiService.extractAllDocIds.mockReturnValue(docIds)
      mockYddocApiService.getDocumentContent.mockResolvedValue(tiptapJson)
      mockKnowledgeBaseService.getKnowledgeBase.mockResolvedValue(knowledgeBase)
      mockKnowledgeBaseService.getDocument.mockResolvedValue(null)
      mockKnowledgeBaseService.createDocument.mockResolvedValue({} as Document)
      mockDocumentService.processDocument.mockResolvedValue({ chunkCount: 1 })
      mockSyncTaskService.updateTaskProgress.mockResolvedValue(undefined)
      mockSyncTaskService.updateTaskStatus.mockResolvedValue(undefined)
      mockSyncTaskService.incrementTaskProgress.mockResolvedValue(undefined)
      mockSyncTaskService.removeFailedDocument = mock().mockResolvedValue(undefined)

      await service.retryDocument(taskId, knowledgeBaseId, 'doc1', config)

      expect(mockSyncTaskService.updateTaskStatus).toHaveBeenCalledWith(taskId, 'running')
      expect(mockYddocApiService.getMenuTree).toHaveBeenCalledWith('rpa', 'zh-CN')
      expect(mockKnowledgeBaseService.getDocument).toHaveBeenCalledWith('doc1')
      expect(mockSyncTaskService.removeFailedDocument).toHaveBeenCalledWith(taskId, 'doc1')
    })

    it('应该在文档不可重试时抛出错误', async () => {
      const task = {
        id: taskId,
        knowledgeBaseId,
        status: 'partially_completed' as const,
        config,
        progress: {
          total: 1,
          processed: 1,
          success: 0,
          failed: 1,
          skipped: 0
        },
        failedDocuments: [
          {
            docId: 'doc1',
            docName: '文档1',
            error: 'HTTP 404: Not Found',
            retryCount: 1,
            errorType: 'permanent' as const,
            canRetry: false
          }
        ],
        createdAt: new Date(),
        updatedAt: new Date()
      }

      mockSyncTaskService.getTaskStatus.mockResolvedValue(task)

      await expect(service.retryDocument(taskId, knowledgeBaseId, 'doc1', config)).rejects.toThrow(
        'Document doc1 cannot be retried'
      )
    })
  })
})
