import { generateText } from 'ai'
import { openaiChat, openaiEmbedding } from '../../../providers/llm.js'
import type { ChunkConfig } from '../types/knowledge-base.types'

export interface LLMSemanticChunkOptions {
  llmModel?: string // LLM 模型名称，默认 'gpt-4o-mini'
  maxChunkSize?: number // 最大块大小（字符数），默认 1000
  minChunkSize?: number // 最小块大小（字符数），默认 100
  customPrompt?: string // 自定义提示词（可选）
  maxRetries?: number // 最大重试次数，默认 3
}

export interface ChunkResult {
  text: string
  startIndex?: number
  endIndex?: number
  summary?: string
}

export interface LLMChunkResponse {
  chunks: ChunkResult[]
  reasoning?: string
}

export class LLMSemanticChunkService {
  /**
   * 使用 LLM 进行语义分割
   */
  async chunkByLLM(
    text: string,
    options: LLMSemanticChunkOptions = {}
  ): Promise<Array<{ text: string; metadata: Record<string, any> }>> {
    const { llmModel = 'gpt-4o-mini', maxChunkSize = 1000, minChunkSize = 100, customPrompt, maxRetries = 3 } = options

    console.log('[LLM Chunking] Starting chunking with model:', llmModel, 'text length:', text.length)

    // 如果文本太短，直接返回
    if (text.length <= maxChunkSize) {
      return [{ text, metadata: {} }]
    }

    // 如果文本太长，需要分块处理
    const MAX_CONTEXT_LENGTH = 8000 // 考虑 token 限制
    if (text.length > MAX_CONTEXT_LENGTH) {
      return await this.chunkLongDocument(text, options)
    }

    // 构建提示词
    const prompt = customPrompt || this.buildPrompt(text, minChunkSize, maxChunkSize)

    // 调用 LLM
    let lastError: Error | null = null
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response = await this.callLLM(prompt, llmModel)
        const chunks = this.parseResponse(response)

        // 验证和调整块
        const validatedChunks = this.validateAndAdjustChunks(chunks, text, minChunkSize, maxChunkSize)

        return validatedChunks.map((chunk, index) => ({
          text: chunk.text,
          metadata: {
            chunkIndex: index,
            summary: chunk.summary,
            startIndex: chunk.startIndex,
            endIndex: chunk.endIndex
          }
        }))
      } catch (error: any) {
        lastError = error
        const errorMessage = error.message || error.toString()
        console.warn(`LLM chunking attempt ${attempt + 1} failed:`, errorMessage)

        // 如果是最后一次尝试，使用回退策略
        if (attempt === maxRetries - 1) {
          console.warn('LLM chunking failed after all retries, using fallback strategy')
          return this.fallbackChunking(text, minChunkSize, maxChunkSize)
        }

        // 等待一下再重试
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)))
      }
    }

    throw lastError || new Error('LLM chunking failed after all retries')
  }

  /**
   * 构建提示词
   */
  private buildPrompt(text: string, minSize: number, maxSize: number): string {
    return `你是一个专业的文档分割专家。你的任务是将给定的文档分割成多个语义完整的块，用于构建知识库和RAG系统。

要求：
1. 保持语义完整性：每个块应该是一个完整的语义单元（如一个主题、一个概念、一个段落组）
2. 识别主题转换：在主题或概念转换的地方进行分割
3. 保持上下文：确保每个块包含足够的上下文信息，能够独立理解
4. 大小控制：每个块应该在 ${minSize} 到 ${maxSize} 字符之间
5. 不切断句子：在句子边界处分割，不要切断句子

文档内容：
${text}

请以 JSON 格式返回分割结果，格式如下：
{
  "chunks": [
    {
      "text": "第一个块的完整文本内容",
      "startIndex": 0,
      "endIndex": 500,
      "summary": "这个块的主题摘要"
    },
    {
      "text": "第二个块的完整文本内容",
      "startIndex": 500,
      "endIndex": 1000,
      "summary": "这个块的主题摘要"
    }
  ],
  "reasoning": "解释你的分割策略和理由"
}

只返回 JSON，不要包含其他文字。`
  }

  /**
   * 调用 LLM
   */
  private async callLLM(prompt: string, model: string): Promise<string> {
    // 处理模型名称：移除 'openai/' 前缀（如果存在）
    let modelName = model
    if (modelName.startsWith('openai/')) {
      modelName = modelName.replace('openai/', '')
    }

    try {
      console.log('[LLM Chunking] Calling LLM with model:', modelName, 'prompt length:', prompt.length)

      // AI SDK v5: 直接使用 prompt 参数（字符串）
      const { text } = await generateText({
        model: openaiChat(modelName),
        prompt: prompt,
        temperature: 0.3 // 降低温度以获得更稳定的结果
      })

      console.log('[LLM Chunking] LLM response received, length:', text.length)
      return text
    } catch (error: any) {
      // 提供更详细的错误信息
      const errorMessage = error.message || error.toString()
      const errorDetails = error.cause || error.response || error.data
      const fullError = {
        message: errorMessage,
        cause: error.cause,
        response: error.response,
        data: error.data,
        stack: error.stack
      }
      console.error('LLM API call error details:', JSON.stringify(fullError, null, 2))
      throw new Error(`LLM API call failed: ${errorMessage}${errorDetails ? ` (${JSON.stringify(errorDetails)})` : ''}`)
    }
  }

  /**
   * 解析 LLM 响应
   */
  private parseResponse(response: string): ChunkResult[] {
    try {
      // 尝试提取 JSON（可能包含 markdown 代码块）
      let jsonStr = response.trim()

      // 移除可能的 markdown 代码块标记
      if (jsonStr.startsWith('```json')) {
        jsonStr = jsonStr.replace(/^```json\s*/, '').replace(/\s*```$/, '')
      } else if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr.replace(/^```\s*/, '').replace(/\s*```$/, '')
      }

      const parsed: LLMChunkResponse = JSON.parse(jsonStr)

      if (!parsed.chunks || !Array.isArray(parsed.chunks)) {
        throw new Error('Invalid response format: missing chunks array')
      }

      return parsed.chunks
    } catch (error: any) {
      throw new Error(`Failed to parse LLM response: ${error.message}`)
    }
  }

  /**
   * 验证和调整块
   */
  private validateAndAdjustChunks(
    chunks: ChunkResult[],
    originalText: string,
    minSize: number,
    maxSize: number
  ): ChunkResult[] {
    const validated: ChunkResult[] = []

    for (const chunk of chunks) {
      // 验证文本是否匹配
      if (chunk.startIndex !== undefined && chunk.endIndex !== undefined) {
        const actualText = originalText.slice(chunk.startIndex, chunk.endIndex)
        if (actualText !== chunk.text) {
          // 如果索引不匹配，使用提供的文本
          chunk.startIndex = originalText.indexOf(chunk.text)
          chunk.endIndex = chunk.startIndex + chunk.text.length
        }
      } else {
        // 如果没有索引，从原文中查找
        const index = originalText.indexOf(chunk.text)
        if (index !== -1) {
          chunk.startIndex = index
          chunk.endIndex = index + chunk.text.length
        }
      }

      // 验证大小
      if (chunk.text.length < minSize) {
        // 如果块太小，尝试与下一个块合并
        continue
      }

      if (chunk.text.length > maxSize) {
        // 如果块太大，需要进一步分割
        const subChunks = this.splitLargeChunk(chunk.text, minSize, maxSize)
        validated.push(
          ...subChunks.map((sub, idx) => ({
            ...sub,
            summary: idx === 0 ? chunk.summary : undefined,
            startIndex: (chunk.startIndex || 0) + idx * maxSize,
            endIndex: Math.min((chunk.startIndex || 0) + (idx + 1) * maxSize, (chunk.startIndex || 0) + chunk.text.length)
          }))
        )
      } else {
        validated.push(chunk)
      }
    }

    return validated
  }

  /**
   * 分割大块
   */
  private splitLargeChunk(text: string, minSize: number, maxSize: number): ChunkResult[] {
    const chunks: ChunkResult[] = []
    let start = 0

    while (start < text.length) {
      let end = Math.min(start + maxSize, text.length)

      // 如果还没到结尾，尝试在句号处分割
      if (end < text.length) {
        const lastPeriod = text.lastIndexOf('.', end)
        const lastNewline = text.lastIndexOf('\n', end)

        if (lastPeriod > start + minSize) {
          end = lastPeriod + 1
        } else if (lastNewline > start + minSize) {
          end = lastNewline + 1
        }
      }

      chunks.push({
        text: text.slice(start, end).trim(),
        startIndex: start,
        endIndex: end
      })

      start = end
    }

    return chunks
  }

  /**
   * 处理长文档（分块发送给 LLM）
   */
  private async chunkLongDocument(
    text: string,
    options: LLMSemanticChunkOptions
  ): Promise<Array<{ text: string; metadata: Record<string, any> }>> {
    const { maxChunkSize = 1000, minChunkSize = 100 } = options

    // 先按段落粗略分割
    const paragraphs = text.split(/\n\n+/)
    const chunks: Array<{ text: string; metadata: Record<string, any> }> = []

    let currentChunk = ''
    let chunkIndex = 0

    const processChunk = async (chunk: string) => {
      if (chunk.length > 8000) {
        return this.fallbackChunking(chunk, minChunkSize, maxChunkSize)
      }
      return this.chunkByLLM(chunk, { ...options, maxChunkSize, minChunkSize })
    }

    for (const paragraph of paragraphs) {
      if (currentChunk.length + paragraph.length > maxChunkSize && currentChunk.length >= minChunkSize) {
        // 对当前块使用 LLM 精细分割
        const llmChunks = await processChunk(currentChunk)

        chunks.push(
          ...llmChunks.map((chunk) => ({
            ...chunk,
            metadata: { ...chunk.metadata, chunkIndex: chunkIndex++ }
          }))
        )

        currentChunk = paragraph
      } else {
        currentChunk += (currentChunk ? '\n\n' : '') + paragraph
      }
    }

    // 处理最后一个块
    if (currentChunk.length >= minChunkSize) {
      const llmChunks = await processChunk(currentChunk)
      chunks.push(
        ...llmChunks.map((chunk) => ({
          ...chunk,
          metadata: { ...chunk.metadata, chunkIndex: chunkIndex++ }
        }))
      )
    }

    return chunks
  }

  /**
   * 回退策略：使用传统方法分割
   */
  private fallbackChunking(
    text: string,
    minSize: number,
    maxSize: number
  ): Array<{ text: string; metadata: Record<string, any> }> {
    const chunks: Array<{ text: string; metadata: Record<string, any> }> = []
    const sentences = text.split(/([.!?。！？]\s+)/)
    let currentChunk = ''

    for (let i = 0; i < sentences.length; i += 2) {
      const sentence = sentences[i] + (sentences[i + 1] || '')

      if (currentChunk.length + sentence.length > maxSize && currentChunk.length >= minSize) {
        chunks.push({
          text: currentChunk.trim(),
          metadata: { chunkIndex: chunks.length }
        })
        currentChunk = sentence
      } else {
        currentChunk += sentence
      }
    }

    if (currentChunk.trim().length >= minSize) {
      chunks.push({
        text: currentChunk.trim(),
        metadata: { chunkIndex: chunks.length }
      })
    }

    return chunks
  }
}
