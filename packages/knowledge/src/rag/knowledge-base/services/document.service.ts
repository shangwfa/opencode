import { MDocument } from '@mastra/rag'
import { embedMany } from 'ai'
import { openaiChat, openaiEmbedding, createEmbeddingModel } from '../../../providers/llm.js'
import { VectorService } from './vector.service'
import { LLMSemanticChunkService } from './llm-semantic-chunk.service'
import type { ChunkStrategy, ChunkConfig, Document } from '../types/knowledge-base.types'
import { extractAllMedia } from '../../../utils/media-extractor.js'
import { tiptapToMarkdown } from '../../../utils/tiptap-to-markdown.js'
import { tiptapToMarkdownLLM } from '../../../utils/tiptap-to-markdown-llm.js'
import { KnowledgeGraphSyncer } from '../../../graph/extraction/index.js'
import { getGraphAdapter } from '../../../graph/pg-adapter/index.js'
import { getDatabaseSchema, getDefaultChatModel } from '../../../config/env.js'

export class DocumentService {
  private vectorService: VectorService
  private embeddingModel: string
  private llmChunkService: LLMSemanticChunkService

  constructor(vectorService: VectorService, embeddingModel: string = 'openai/text-embedding-3-small') {
    this.vectorService = vectorService
    this.embeddingModel = embeddingModel
    this.llmChunkService = new LLMSemanticChunkService()
  }

  /**
   * 处理文档：分块、生成嵌入、存储向量
   */
async processDocument(
    knowledgeBaseId: string,
    content: string,
    documentId: string,
    type: 'text' | 'markdown' | 'html' | 'tiptap' = 'text',
    chunkStrategy: ChunkStrategy = 'recursive',
    chunkConfig?: ChunkConfig,
    documentMetadata?: Record<string, any>,
    embeddingModel?: string,
    syncToGraph?: boolean
  ): Promise<{ chunkCount: number }> {
    // 如果类型是 tiptap，先转换为 markdown
    let actualContent = content
    let actualType = type
    if (type === 'tiptap') {
      console.log(`[文档处理] 检测到 tiptap 类型，开始转换为 markdown`)
      try {
        // 解析 tiptapJson
        const tiptapJson = JSON.parse(content)
        
        // 优先使用 LLM 方法转换
        try {
          actualContent = await tiptapToMarkdownLLM(tiptapJson, {
            enableValidation: true,
            contentRetentionThreshold: 0.9
          })
          console.log(`[文档处理] LLM 转换完成，markdown 长度: ${actualContent.length}`)
        } catch (llmError: any) {
          console.warn(`[文档处理] LLM 转换失败，降级到 prosemirror 方法: ${llmError.message}`)
          // 降级到 prosemirror 方法
          actualContent = tiptapToMarkdown(tiptapJson)
          console.log(`[文档处理] prosemirror 转换完成，markdown 长度: ${actualContent.length}`)
        }
        
        // 检查转换后的 markdown 是否为空
        if (!actualContent || actualContent.trim().length === 0) {
          throw new Error('Document content is empty or contains only whitespace after conversion from tiptap')
        }
        
        actualType = 'markdown'
      } catch (error: any) {
        console.error(`[文档处理] tiptap 转换失败: ${error.message}`)
        throw new Error(`Failed to convert tiptap to markdown: ${error.message}`)
      }
    }

    // 创建文档对象
    let doc: MDocument
    if (actualType === 'markdown') {
      doc = MDocument.fromMarkdown(actualContent)
    } else if (actualType === 'html') {
      doc = MDocument.fromHTML(actualContent)
    } else {
      doc = MDocument.fromText(actualContent)
    }

    // 提取媒体资源（仅对 Markdown 和 HTML 文档）
    let enhancedMetadata = { ...(documentMetadata || {}) }
    if (actualType === 'markdown' || actualType === 'html') {
      const media = extractAllMedia(actualContent, documentMetadata)
      // 将媒体资源添加到元数据中，方便后续搜索时使用
      if (media.images.length > 0 || media.videos.length > 0) {
        enhancedMetadata = {
          ...enhancedMetadata,
          images: media.images,
          videos: media.videos
        }
      }
    }

    // 检查内容是否为空
    if (!actualContent || actualContent.trim().length === 0) {
      throw new Error('Document content is empty or contains only whitespace')
    }

    // 根据策略分块
    let chunks: Array<{ text: string; metadata: Record<string, any> }>

    if (chunkStrategy === 'none') {
      // 不分割，整个文档作为一个块
      chunks = [{ text: actualContent, metadata: {} }]
    } else if (actualType === 'markdown') {
      // 对于markdown类型的文档，强制使用markdown分块策略，保留markdown格式
      console.log(`[分块] 使用markdown策略对文档进行分块 (文档类型: ${actualType}, 原策略: ${chunkStrategy})`)
      console.log(`[分块] 文档内容长度: ${actualContent.length} 字符`)
      
      // 强制使用markdown策略
      const chunked = await this.chunkDocument(doc, 'markdown', chunkConfig, actualContent)
      console.log(`[分块] chunkDocument 返回了 ${chunked.length} 个chunks`)
      
      if (chunked.length === 0) {
        throw new Error(`chunkDocument returned no chunks for markdown document (content length: ${actualContent.length})`)
      }
      
      // 检查MDocument.chunk()返回的chunk是否已经是markdown格式
      // 如果第一个chunk包含markdown标记，说明已经是markdown格式，直接使用
      // 否则需要从原始markdown中提取
      const firstChunkText = chunked[0]?.text || ''
      const isAlreadyMarkdown = /^#{1,6}\s|^\*\*|^\*[^*]|\[.*?\]\(|`|!\[|<video/i.test(firstChunkText)
      
      if (isAlreadyMarkdown) {
        // 已经是markdown格式，直接使用
        console.log(`[分块] MDocument.chunk()返回的chunk已经是markdown格式，直接使用`)
        chunks = chunked.map((chunk) => ({
          text: chunk.text || '',
          metadata: chunk.metadata || {}
        }))
      } else {
        // 不是markdown格式，从原始markdown中提取
        console.log(`[分块] MDocument.chunk()返回的chunk是纯文本格式，从原始markdown中提取`)
        chunks = this.extractMarkdownChunks(actualContent, chunked)
        console.log(`[分块] extractMarkdownChunks 返回了 ${chunks.length} 个chunks`)
      }
      
      console.log(`[分块] 生成了 ${chunks.length} 个chunks`)
      
      // 调试：输出前3个chunk的前200个字符，确认是否为markdown格式
      chunks.slice(0, 3).forEach((chunk, index) => {
        if (chunk.text) {
          const chunkPreview = chunk.text.substring(0, 200)
          console.log(`[分块调试] Chunk ${index + 1} (${chunk.text.length}字符):`)
          console.log(chunkPreview)
          const hasMarkdown = /^#{1,6}\s|^\*\*|^\*[^*]|\[.*?\]\(|`|!\[|<video/i.test(chunk.text)
          console.log(`[分块调试] 包含markdown标记: ${hasMarkdown}\n`)
        } else {
          console.log(`[分块调试] Chunk ${index + 1} 是空的`)
        }
      })
    } else {
      // 对于非markdown类型或llm-semantic策略，使用MDocument的分块结果
      const chunked = await this.chunkDocument(doc, chunkStrategy, chunkConfig, content)
      console.log(`[分块] chunkDocument 返回了 ${chunked.length} 个chunks`)
      chunks = chunked.map((chunk) => ({
        text: chunk.text || '',
        metadata: chunk.metadata || {}
      }))
    }

    // 过滤掉空字符串的 chunks
    const beforeFilterCount = chunks.length
    chunks = chunks.filter((chunk) => chunk.text && chunk.text.trim().length > 0)
    const afterFilterCount = chunks.length
    
    console.log(`[分块] 过滤前: ${beforeFilterCount} 个chunks, 过滤后: ${afterFilterCount} 个chunks`)

    if (chunks.length === 0) {
      throw new Error(`No valid chunks generated from document (content length: ${content.length}, before filter: ${beforeFilterCount} chunks)`)
    }

    // 生成嵌入向量
    // 根据 embeddingModel 选择对应的嵌入服务
    // 优先使用传入的 embeddingModel，否则使用构造函数传入的默认值
    const modelName = embeddingModel || this.embeddingModel
    let embeddingModelInstance: any
    if (modelName === 'zhipu/embedding-3') {
      // 使用智谱 Embedding-3 模型（修复源项目 bug：原 createZhipuEmbeddingModel() 不存在，统一走 createEmbeddingModel）
      embeddingModelInstance = createEmbeddingModel(modelName)
    } else if (modelName.startsWith('openai/')) {
      const openaiModelName = modelName.replace('openai/', '')
      // 使用 openai 客户端，会自动读取 OPENAI_BASE_URL 环境变量
      // 确保环境变量已加载（在脚本中已经通过 dotenv.config() 加载）
      embeddingModelInstance = openaiEmbedding(openaiModelName)
    } else {
      embeddingModelInstance = openaiEmbedding(modelName)
    }

    const texts = chunks.map((chunk) => chunk.text).filter((text) => text && text.trim().length > 0)

    if (texts.length === 0) {
      throw new Error('No valid texts for embedding generation')
    }

    const { embeddings } = await embedMany({
      model: embeddingModelInstance,
      values: texts
    })

    // 准备元数据和向量ID
    // 将文档级别的 metadata 合并到每个 chunk 的 metadata 中
    const metadata = chunks.map((chunk, index) => ({
      documentId,
      chunkIndex: index,
      text: chunk.text,
      ...enhancedMetadata, // 文档级别的 metadata（包含媒体资源）
      ...chunk.metadata // chunk 级别的 metadata（会覆盖文档级别的同名字段）
    }))

    const vectorIds = chunks.map((_, index) => `${documentId}_${index}`)

    // 存储向量
    await this.vectorService.upsertVectors(knowledgeBaseId, embeddings, metadata, vectorIds)

    // 可选：同步到知识图谱
    if (syncToGraph) {
      try {
        const schemaName = getDatabaseSchema()
        const graphAdapter = getGraphAdapter(schemaName)
        const syncer = new KnowledgeGraphSyncer(graphAdapter, { model: getDefaultChatModel() })
        const result = await syncer.syncChunks(
          chunks.map((chunk, index) => ({ text: chunk.text, index })),
          {
            knowledgeBaseId,
            documentId,
            model: getDefaultChatModel(),
          }
        )
        console.log(`[文档处理] 知识图谱同步完成: ${result.totalNodes} 节点, ${result.totalEdges} 边`)
      } catch (graphError: any) {
        console.warn(`[文档处理] 知识图谱同步失败（不影响文档主流程）: ${graphError.message}`)
      }
    }

    return {
      chunkCount: chunks.length
    }
  }

  /**
   * 更新文档：使用事务确保原子性
   * 改进：协调元数据更新和向量化，确保一致性
   */
  async updateDocument(
    knowledgeBaseId: string,
    documentId: string,
    content?: string,
    type?: 'text' | 'markdown' | 'html' | 'tiptap',
    chunkStrategy?: ChunkStrategy,
    chunkConfig?: ChunkConfig,
    documentMetadata?: Record<string, any>,
    embeddingModel?: string,
    syncToGraph?: boolean
  ): Promise<{ chunkCount: number }> {
    if (!content || !type) {
      return { chunkCount: 0 }
    }

    // 两阶段提交：先创建新向量，再删除旧向量，避免向量丢失
    let oldVectorIds: string[] = []
    let newVectorIds: string[] = []

    try {
      // 阶段1：获取旧向量ID（用于后续删除）
      try {
        oldVectorIds = await this.vectorService.getDocumentVectorIds(knowledgeBaseId, documentId)
        console.log(`[文档更新] 文档 ${documentId} 现有 ${oldVectorIds.length} 个旧向量`)
      } catch (error: any) {
        console.warn(`[文档更新] 获取旧向量ID失败（可能是新文档）: ${error.message}`)
        // 继续执行，可能这是新文档
      }

      // 阶段2：处理新文档并创建新向量
      console.log(`[文档更新] 开始创建新向量...`)
      const result = await this.processDocument(
        knowledgeBaseId,
        content,
        documentId,
        type,
        chunkStrategy || 'recursive',
        chunkConfig,
        documentMetadata,
        embeddingModel,
        syncToGraph
      )

      const expectedNewVectorIds = Array.from({ length: result.chunkCount }, (_, index) => `${documentId}_${index}`)

      // 阶段3：验证新向量创建成功
      try {
        newVectorIds = await this.vectorService.getDocumentVectorIds(knowledgeBaseId, documentId)
        console.log(`[文档更新] 新向量创建成功，共 ${newVectorIds.length} 个向量`)
        
        const missingVectorIds = expectedNewVectorIds.filter((id) => !newVectorIds.includes(id))
        if (missingVectorIds.length > 0) {
          throw new Error(
            `Vector count mismatch: missing ${missingVectorIds.length} expected vectors (${missingVectorIds.join(', ')})`
          )
        }
      } catch (error: any) {
        console.error(`[文档更新] 验证新向量失败: ${error.message}`)
        // 清理可能已创建的部分向量
        console.warn(`[文档更新] 清理可能已创建的新向量...`)
        try {
          // 获取所有当前向量（包括新创建的）
          const allVectorIds = await this.vectorService.getDocumentVectorIds(knowledgeBaseId, documentId)
          // 只删除新创建的向量（不在旧向量列表中的）
          const vectorsToDelete = allVectorIds.filter((id) => !oldVectorIds.includes(id))
          if (vectorsToDelete.length > 0) {
            await this.vectorService.deleteBatch(knowledgeBaseId, vectorsToDelete)
          }
        } catch (cleanupError: any) {
          console.error(`[文档更新] 清理新向量失败: ${cleanupError.message}`)
        }
        throw new Error(`Failed to verify new vectors: ${error.message}`)
      }

      // 阶段4：删除旧向量（新向量已创建成功，可以安全删除旧向量）
      if (oldVectorIds.length > 0) {
        console.log(`[文档更新] 删除 ${oldVectorIds.length} 个旧向量...`)
        try {
          // 新旧向量 ID 都是 `${documentId}_${index}`。当新 chunk 数减少时，
          // 超出新范围的旧向量不会被 upsert 覆盖，必须显式删除。
          const vectorsToDelete = oldVectorIds.filter((id) => !expectedNewVectorIds.includes(id))
          if (vectorsToDelete.length > 0) {
            await this.vectorService.deleteBatch(knowledgeBaseId, vectorsToDelete)
            console.log(`[文档更新] 成功删除 ${vectorsToDelete.length} 个旧向量`)
          } else {
            console.log(`[文档更新] 所有旧向量已被新向量覆盖，无需删除`)
          }
        } catch (deleteError: any) {
          console.error(`[文档更新] 删除旧向量失败: ${deleteError.message}`)
          // 即使删除旧向量失败，新向量已经创建成功，可以继续
          // 但需要记录警告，因为可能存在重复向量
          console.warn(
            `[文档更新] 警告：旧向量删除失败，可能存在重复向量。建议手动清理。`
          )
        }
      }

      console.log(`[文档更新] 文档 ${documentId} 更新完成，共 ${result.chunkCount} 个块`)
      return result
    } catch (error: any) {
      // 失败时清理新创建的向量
      console.error(`[文档更新] 文档更新失败: ${error.message}`)

      // 尝试清理新创建的向量（不在旧向量列表中的）
      try {
        const allVectorIds = await this.vectorService.getDocumentVectorIds(knowledgeBaseId, documentId)
        const vectorsToDelete = allVectorIds.filter((id) => !oldVectorIds.includes(id))
        if (vectorsToDelete.length > 0) {
          console.warn(`[文档更新] 清理 ${vectorsToDelete.length} 个新创建的向量...`)
          await this.vectorService.deleteBatch(knowledgeBaseId, vectorsToDelete)
          console.log(`[文档更新] 新向量清理完成`)
        }
      } catch (cleanupError: any) {
        console.error(`[文档更新] 清理新向量失败: ${cleanupError.message}`)
        // 记录错误，但继续抛出原始错误
      }

      // 如果旧向量还存在，记录信息
      if (oldVectorIds.length > 0) {
        console.log(
          `[文档更新] 旧向量（${oldVectorIds.length} 个）仍然存在，文档可以继续使用`
        )
      }

      throw error
    }
  }

  /**
   * 更新文档（带重试机制）
   * 改进：添加自动重试功能
   */
  async updateDocumentWithRetry(
    knowledgeBaseId: string,
    documentId: string,
    content: string,
    type: 'text' | 'markdown' | 'html' | 'tiptap',
    chunkStrategy?: ChunkStrategy,
    chunkConfig?: ChunkConfig,
    documentMetadata?: Record<string, any>,
    embeddingModel?: string,
    maxRetries: number = 3
  ): Promise<{ chunkCount: number }> {
    let lastError: Error

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this.updateDocument(
          knowledgeBaseId,
          documentId,
          content,
          type,
          chunkStrategy,
          chunkConfig,
          documentMetadata,
          embeddingModel
        )
      } catch (error: any) {
        lastError = error

        // 判断是否可重试
        const isRetryable =
          error.message?.includes('deadlock') ||
          error.message?.includes('connection') ||
          error.message?.includes('timeout') ||
          error.message?.includes('ECONNRESET')

        if (!isRetryable || attempt === maxRetries) {
          throw error
        }

        // 指数退避
        const delay = Math.pow(2, attempt) * 1000
        console.warn(`Document update failed (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms...`, error.message)
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }

    throw lastError!
  }

  /**
   * 将纯文本按知识库分块策略切分为块（供 database API 行向量化等复用）
   */
  async chunkPlainText(
    text: string,
    chunkStrategy: ChunkStrategy,
    chunkConfig?: ChunkConfig
  ): Promise<Array<{ text: string; metadata: Record<string, unknown> }>> {
    if (!text || !String(text).trim()) {
      throw new Error('Empty text for chunking')
    }
    if (chunkStrategy === 'none') {
      return [{ text: String(text), metadata: {} }]
    }
    const doc = MDocument.fromText(text)
    const chunked = await this.chunkDocument(doc, chunkStrategy, chunkConfig, text)
    const chunks = chunked
      .map((chunk) => ({
        text: chunk.text || '',
        metadata: (chunk.metadata || {}) as Record<string, unknown>
      }))
      .filter((c) => c.text.trim().length > 0)
    if (chunks.length === 0) {
      throw new Error('No valid chunks generated from text')
    }
    return chunks
  }

  /**
   * 分块文档
   */
  private async chunkDocument(doc: MDocument, strategy: ChunkStrategy, config?: ChunkConfig, content?: string) {
    const defaultConfig: ChunkConfig = {
      maxSize: 512,
      overlap: 50,
      separators: ['\n\n', '\n', ' ']
    }

    const finalConfig = { ...defaultConfig, ...config }

    switch (strategy) {
      case 'recursive':
        return await doc.chunk({
          strategy: 'recursive',
          maxSize: finalConfig.maxSize || 512,
          overlap: finalConfig.overlap || 50,
          separators: finalConfig.separators || ['\n\n', '\n', ' ']
        })

      case 'character':
        return await doc.chunk({
          strategy: 'character',
          maxSize: finalConfig.maxSize || 512,
          overlap: finalConfig.overlap || 50
        })

      case 'token':
        return await doc.chunk({
          strategy: 'token',
          maxSize: finalConfig.maxTokens || 512,
          overlap: finalConfig.overlapTokens || 50
        })

      case 'markdown':
        return await doc.chunk({
          strategy: 'markdown',
          maxSize: finalConfig.maxSize || 512,
          overlap: finalConfig.overlap || 50
        })

      case 'semantic-markdown':
        return await doc.chunk({
          strategy: 'semantic-markdown',
          joinThreshold: finalConfig.joinThreshold || 500,
          modelName: finalConfig.modelName || ('gpt-3.5-turbo' as any)
        })

      case 'llm-semantic': {
        // 使用 LLM 进行语义分割
        // MDocument 没有 getContent 方法，需要从原始内容获取
        const text = content || ''
        if (!text || text.trim().length === 0) {
          throw new Error('Document content is empty')
        }

        const chunks = await this.llmChunkService.chunkByLLM(text, {
          llmModel: finalConfig.llmModel || 'gpt-4o-mini',
          maxChunkSize: finalConfig.maxSize || 1000,
          minChunkSize: finalConfig.minSize || 100,
          customPrompt: finalConfig.customPrompt
        })

        if (!chunks || chunks.length === 0) {
          throw new Error('LLM chunking returned no chunks')
        }

        // 转换为 MDocument chunk 格式
        return chunks.map((chunk, index) => ({
          text: chunk.text || '',
          metadata: {
            ...chunk.metadata,
            chunkIndex: index
          }
        }))
      }

      case 'html':
        return await doc.chunk({
          strategy: 'html',
          maxSize: finalConfig.maxSize || 512,
          overlap: finalConfig.overlap || 50,
          sections: [] as [string, string][] // HTML chunk requires sections
        })

      case 'json':
        return await doc.chunk({
          strategy: 'json',
          maxSize: finalConfig.maxSize || 512,
          overlap: finalConfig.overlap || 50
        })

      case 'latex':
        return await doc.chunk({
          strategy: 'latex',
          maxSize: finalConfig.maxSize || 512,
          overlap: finalConfig.overlap || 50
        })

      case 'sentence':
        return await doc.chunk({
          strategy: 'sentence',
          maxSize: finalConfig.maxSize || 450,
          minSize: finalConfig.minSize || 50,
          overlap: finalConfig.overlap || 0,
          sentenceEnders: finalConfig.sentenceEnders || ['.', '!', '?'],
          keepSeparator: finalConfig.keepSeparator ?? true
        })

      default:
        return await doc.chunk({
          strategy: 'recursive',
          maxSize: finalConfig.maxSize || 512,
          overlap: finalConfig.overlap || 50
        })
    }
  }

  /**
   * 从原始markdown内容中提取对应位置的markdown chunk
   * 当MDocument.chunk()返回纯文本时，需要从原始markdown中提取对应位置的markdown格式内容
   * 
   * 策略：通过文本匹配找到chunk在原始markdown中的位置，然后提取该位置的markdown内容
   */
  private extractMarkdownChunks(
    originalMarkdown: string,
    textChunks: Array<{ text: string; metadata: Record<string, any> }>
  ): Array<{ text: string; metadata: Record<string, any> }> {
    const markdownChunks: Array<{ text: string; metadata: Record<string, any> }> = []
    let searchStartPos = 0

    for (let i = 0; i < textChunks.length; i++) {
      const textChunk = textChunks[i]
      const chunkText = textChunk.text || ''
      
      if (!chunkText.trim()) {
        // 跳过空chunk，不添加到结果中
        console.warn(`[extractMarkdownChunks] 跳过空的 textChunk ${i + 1}/${textChunks.length}`)
        continue
      }

      // 方法1: 尝试在原始markdown中查找chunk文本的纯文本部分
      // 移除markdown标记，只保留文本内容进行匹配
      const normalizeText = (text: string): string => {
        // 移除markdown标记，保留文本内容
        return text
          .replace(/#{1,6}\s+/g, '') // 标题标记
          .replace(/\*\*([^*]+)\*\*/g, '$1') // 粗体
          .replace(/\*([^*]+)\*/g, '$1') // 斜体
          .replace(/`([^`]+)`/g, '$1') // 行内代码
          .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1') // 链接
          .replace(/!\[([^\]]*)\]\([^\)]+\)/g, '') // 图片
          .replace(/<[^>]+>/g, '') // HTML标签
          .replace(/\s+/g, ' ') // 规范化空白字符
          .trim()
      }

      const normalizedChunkText = normalizeText(chunkText)
      const normalizedMarkdown = normalizeText(originalMarkdown)
      
      // 在规范化后的markdown中查找chunk位置
      let foundIndex = normalizedMarkdown.indexOf(normalizedChunkText, searchStartPos)
      
      if (foundIndex === -1 && i > 0) {
        // 如果找不到，尝试从文档开头查找（可能是第一个chunk）
        foundIndex = normalizedMarkdown.indexOf(normalizedChunkText, 0)
      }

      if (foundIndex === -1) {
        // 如果还是找不到，使用更宽松的匹配：只匹配前30个字符
        const chunkPrefix = normalizedChunkText.substring(0, Math.min(30, normalizedChunkText.length))
        foundIndex = normalizedMarkdown.indexOf(chunkPrefix, searchStartPos)
      }

      if (foundIndex === -1) {
        // 如果完全找不到，使用估算位置（基于之前chunk的位置和长度）
        if (i > 0 && markdownChunks[i - 1]) {
          const prevChunk = markdownChunks[i - 1]
          // 估算：假设前一个chunk在原始markdown中的位置
          // 这里我们使用一个简单的策略：按比例估算
          const estimatedPos = Math.floor((originalMarkdown.length * i) / textChunks.length)
          foundIndex = estimatedPos
        } else {
          foundIndex = 0
        }
      }

      // 将规范化位置映射回原始markdown位置
      // 由于规范化会改变长度，我们需要近似映射
      let originalStartPos = foundIndex
      if (foundIndex < normalizedMarkdown.length) {
        // 尝试找到原始markdown中对应的位置
        // 通过计算规范化前后的字符数差异来估算
        const beforeNormalized = normalizedMarkdown.substring(0, foundIndex)
        const beforeOriginal = originalMarkdown.substring(0, Math.min(originalStartPos * 2, originalMarkdown.length))
        
        // 简单估算：规范化后的位置 * 1.2（考虑markdown标记会增加长度）
        originalStartPos = Math.floor(foundIndex * 1.2)
        originalStartPos = Math.min(originalStartPos, originalMarkdown.length - 1)
      }

      // 估算chunk的结束位置
      // 考虑markdown标记，chunk的实际长度可能比纯文本长
      const estimatedChunkLength = Math.min(
        chunkText.length * 2, // markdown标记可能使长度翻倍
        originalMarkdown.length - originalStartPos
      )
      
      let chunkEndPos = originalStartPos + estimatedChunkLength

      // 尝试在段落边界结束（\n\n）
      const paragraphEnd = originalMarkdown.indexOf('\n\n', originalStartPos)
      if (paragraphEnd !== -1 && paragraphEnd < chunkEndPos && paragraphEnd > originalStartPos) {
        chunkEndPos = paragraphEnd + 2
      } else {
        // 尝试在行边界结束
        const lineEnd = originalMarkdown.indexOf('\n', originalStartPos + chunkText.length)
        if (lineEnd !== -1 && lineEnd < chunkEndPos) {
          chunkEndPos = lineEnd + 1
        }
      }

      // 确保不超过文档末尾
      chunkEndPos = Math.min(chunkEndPos, originalMarkdown.length)

      // 提取markdown chunk
      let markdownChunk = originalMarkdown.substring(originalStartPos, chunkEndPos).trim()

      // 验证提取的chunk是否包含chunk文本的主要内容
      const extractedNormalized = normalizeText(markdownChunk)
      if (!extractedNormalized.includes(normalizedChunkText.substring(0, Math.min(20, normalizedChunkText.length)))) {
        // 如果提取的内容不匹配，尝试扩展范围
        const extendedEnd = Math.min(originalStartPos + chunkText.length * 3, originalMarkdown.length)
        markdownChunk = originalMarkdown.substring(originalStartPos, extendedEnd).trim()
      }

      markdownChunks.push({
        text: markdownChunk || chunkText, // 如果提取失败，使用原始文本作为后备
        metadata: textChunk.metadata || {}
      })

      // 更新搜索起始位置，用于下一个chunk的查找
      searchStartPos = chunkEndPos
    }

    return markdownChunks
  }
}
