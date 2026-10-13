import { describe, expect, it, mock } from 'bun:test'
import { BaseKnowledgeService } from './base-knowledge.service.js'
import { hashDocumentContent, serializeContent } from './utils.js'

function storedDocument(overrides: Record<string, unknown> = {}) {
  const content = '# existing'
  return {
    knowledgeBaseId: 'kb-1',
    documentId: 'doc-1',
    content,
    normalizedContent: content,
    contentHash: hashDocumentContent(content, 'markdown'),
    type: 'markdown' as const,
    chunkCount: 1,
    version: 1,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides
  }
}

describe('BaseKnowledgeService', () => {
  it('rejects a duplicate before invoking embedding', async () => {
    const repository = {
      getDocument: mock().mockResolvedValue(storedDocument())
    }
    const vectorization = {
      vectorize: mock()
    }
    const service = new BaseKnowledgeService(repository as any, vectorization as any)

    await expect(
      service.createDocument('kb-1', {
        documentId: 'doc-1',
        type: 'markdown',
        content: '# duplicate'
      })
    ).rejects.toMatchObject({ status: 409, code: 'DOCUMENT_ALREADY_EXISTS' })
    expect(vectorization.vectorize).not.toHaveBeenCalled()
  })

  it('stores original TipTap JSON and vectorizes its normalized representation', async () => {
    const tiptap = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }]
    }
    const created = storedDocument({ type: 'tiptap' })
    const repository = {
      getDocument: mock().mockResolvedValue(null),
      getSpace: mock().mockResolvedValue(null),
      getEmbeddingModel: mock().mockResolvedValue('openai/text-embedding-3-small'),
      createDocument: mock().mockResolvedValue(created)
    }
    const vectorization = {
      vectorize: mock().mockResolvedValue({
        normalizedContent: 'hello',
        embeddingDimension: 2,
        chunks: [
          {
            id: 'doc-1_0',
            documentId: 'doc-1',
            chunkIndex: 0,
            text: 'hello',
            embedding: [0.1, 0.2],
            metadata: {}
          }
        ]
      })
    }
    const service = new BaseKnowledgeService(repository as any, vectorization as any)

    await service.createDocument('kb-1', {
      documentId: 'doc-1',
      type: 'tiptap',
      content: tiptap
    })

    expect(vectorization.vectorize).toHaveBeenCalledWith(
      expect.objectContaining({
        content: serializeContent(tiptap),
        type: 'tiptap'
      })
    )
    expect(repository.createDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        content: serializeContent(tiptap),
        normalizedContent: 'hello',
        type: 'tiptap'
      })
    )
  })

  it('keeps PUT idempotent when content and type are unchanged', async () => {
    const current = storedDocument()
    const repository = {
      getDocument: mock().mockResolvedValue(current)
    }
    const vectorization = {
      vectorize: mock()
    }
    const service = new BaseKnowledgeService(repository as any, vectorization as any)

    const result = await service.updateDocument('kb-1', 'doc-1', {
      content: '# existing'
    })

    expect(result).toBe(current)
    expect(vectorization.vectorize).not.toHaveBeenCalled()
  })

  it('rejects object content when the effective type is not TipTap', async () => {
    const repository = {
      getDocument: mock().mockResolvedValue(storedDocument())
    }
    const service = new BaseKnowledgeService(repository as any, { vectorize: mock() } as any)

    await expect(
      service.updateDocument('kb-1', 'doc-1', {
        content: { type: 'doc' }
      })
    ).rejects.toMatchObject({ status: 400, code: 'INVALID_CONTENT_TYPE' })
  })
})

