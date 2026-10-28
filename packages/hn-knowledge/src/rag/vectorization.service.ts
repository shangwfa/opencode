import { MDocument } from '@mastra/rag'
import { embedMany } from 'ai'
import { openaiEmbedding } from '../providers/llm.js'
import { tiptapToMarkdown } from '../utils/tiptap-to-markdown.js'
import {
  EMBEDDING_BATCH_SIZE,
  MAX_CHUNKS_PER_DOCUMENT,
  MAX_CONTENT_BYTES,
  MAX_WRITE_CONCURRENCY
} from './constants.js'
import { BaseKnowledgeError } from './errors.js'
import { Semaphore } from './semaphore.js'
import type { BaseKnowledgeChunk, BaseKnowledgeContentType } from './types.js'

const writeSemaphore = new Semaphore(MAX_WRITE_CONCURRENCY)

export interface VectorizedDocument {
  normalizedContent: string
  chunks: BaseKnowledgeChunk[]
  embeddingDimension: number
}

export class BaseKnowledgeVectorizationService {
  async vectorize(input: {
    documentId: string
    content: string
    type: BaseKnowledgeContentType
    embeddingModel: string
    signal?: AbortSignal
  }): Promise<VectorizedDocument> {
    return writeSemaphore.run(async () => {
      const contentBytes = Buffer.byteLength(input.content, 'utf8')
      if (contentBytes > MAX_CONTENT_BYTES) {
        throw new BaseKnowledgeError(
          `Document content exceeds the ${MAX_CONTENT_BYTES} byte limit`,
          413,
          'CONTENT_TOO_LARGE'
        )
      }

      const normalizedContent = this.normalizeContent(input.content, input.type)
      if (!normalizedContent.trim()) {
        throw new BaseKnowledgeError('Document content is empty after normalization', 422, 'EMPTY_DOCUMENT')
      }

      const texts = await this.chunkContent(normalizedContent, input.type)
      if (texts.length === 0) {
        throw new BaseKnowledgeError('Document produced no searchable chunks', 422, 'EMPTY_DOCUMENT')
      }
      if (texts.length > MAX_CHUNKS_PER_DOCUMENT) {
        throw new BaseKnowledgeError(
          `Document generated ${texts.length} chunks, exceeding the ${MAX_CHUNKS_PER_DOCUMENT} chunk limit`,
          422,
          'TOO_MANY_CHUNKS'
        )
      }

      const embeddings = await this.embedInBatches(texts, input.embeddingModel, input.signal)
      const embeddingDimension = embeddings[0]?.length || 0
      if (
        !embeddingDimension ||
        embeddings.some(
          (embedding) =>
            embedding.length !== embeddingDimension || embedding.some((value) => !Number.isFinite(value))
        )
      ) {
        throw new BaseKnowledgeError('Embedding dimensions are empty or inconsistent', 502, 'INVALID_EMBEDDING')
      }

      return {
        normalizedContent,
        embeddingDimension,
        chunks: texts.map((text, chunkIndex) => ({
          id: `${input.documentId}_${chunkIndex}`,
          documentId: input.documentId,
          chunkIndex,
          text,
          embedding: embeddings[chunkIndex],
          metadata: {
            documentId: input.documentId,
            chunkIndex,
            text
          }
        }))
      }
    })
  }

  private normalizeContent(content: string, type: BaseKnowledgeContentType): string {
    if (type !== 'tiptap') return content

    try {
      // 原始 TipTap JSON 保存在业务表；这里只生成用于分块和检索的 Markdown。
      return tiptapToMarkdown(JSON.parse(content))
    } catch (error: any) {
      throw new BaseKnowledgeError(
        `Invalid Tiptap content: ${error?.message || String(error)}`,
        422,
        'INVALID_TIPTAP_CONTENT'
      )
    }
  }

  private async chunkContent(content: string, type: BaseKnowledgeContentType): Promise<string[]> {
    const effectiveType = type === 'tiptap' ? 'markdown' : type
    const document =
      effectiveType === 'markdown'
        ? MDocument.fromMarkdown(content)
        : effectiveType === 'html'
          ? MDocument.fromHTML(content)
          : MDocument.fromText(content)

    const chunks =
      effectiveType === 'markdown'
        ? await document.chunk({
            strategy: 'markdown',
            maxSize: 512,
            overlap: 50
          })
        : await document.chunk({
            strategy: 'recursive',
            maxSize: 512,
            overlap: 50
          })

    return chunks.map((chunk) => chunk.text?.trim()).filter((text): text is string => Boolean(text))
  }

  private async embedInBatches(texts: string[], embeddingModel: string, signal?: AbortSignal): Promise<number[][]> {
    const modelName = embeddingModel.startsWith('openai/')
      ? embeddingModel.slice('openai/'.length)
      : embeddingModel
    const model = openaiEmbedding(modelName)
    const embeddings: number[][] = []

    for (let offset = 0; offset < texts.length; offset += EMBEDDING_BATCH_SIZE) {
      if (signal?.aborted) throw signal.reason || new Error('Embedding aborted')

      const batch = texts.slice(offset, offset + EMBEDDING_BATCH_SIZE)
      const result = await embedMany({
        model,
        values: batch,
        abortSignal: signal
      })
      embeddings.push(...result.embeddings)
    }

    if (embeddings.length !== texts.length) {
      throw new BaseKnowledgeError('Embedding count does not match chunk count', 502, 'EMBEDDING_COUNT_MISMATCH')
    }
    return embeddings
  }
}
