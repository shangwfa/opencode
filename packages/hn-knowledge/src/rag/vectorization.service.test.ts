import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { MAX_CONTENT_BYTES } from './constants.js'
import { serializeContent } from './utils.js'

const mocks = {
  fromMarkdown: mock(),
  fromHTML: mock(),
  fromText: mock(),
  chunk: mock(),
  embedMany: mock(),
  openaiEmbedding: mock(() => ({ modelId: 'test' }))
}

mock.module('@mastra/rag', () => ({
  MDocument: {
    fromMarkdown: mocks.fromMarkdown,
    fromHTML: mocks.fromHTML,
    fromText: mocks.fromText
  }
}))
mock.module('ai', () => ({ embedMany: mocks.embedMany, embed: mock() }))
mock.module('../providers/llm.js', () => ({
  openaiEmbedding: mocks.openaiEmbedding
}))

const { BaseKnowledgeVectorizationService } = await import('./vectorization.service.js')

describe('BaseKnowledgeVectorizationService', () => {
  beforeEach(() => {
    mock.clearAllMocks()
    mocks.chunk.mockResolvedValue([{ text: '# Title\n\nHello', metadata: {} }])
    mocks.fromMarkdown.mockReturnValue({ chunk: mocks.chunk })
    mocks.fromHTML.mockReturnValue({ chunk: mocks.chunk })
    mocks.fromText.mockReturnValue({ chunk: mocks.chunk })
    mocks.embedMany.mockResolvedValue({ embeddings: [[0.1, 0.2, 0.3]] })
  })

  it('converts TipTap JSON to Markdown before chunking', async () => {
    const service = new BaseKnowledgeVectorizationService()
    const content = serializeContent({
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 1 },
          content: [{ type: 'text', text: 'Title' }]
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Hello' }]
        }
      ]
    })

    const result = await service.vectorize({
      documentId: 'doc-1',
      content,
      type: 'tiptap',
      embeddingModel: 'openai/text-embedding-3-small'
    })

    expect(mocks.fromMarkdown).toHaveBeenCalledWith(expect.stringContaining('Title'))
    expect(result.embeddingDimension).toBe(3)
    expect(result.chunks[0]).toMatchObject({
      id: 'doc-1_0',
      documentId: 'doc-1',
      chunkIndex: 0
    })
  })

  it('rejects oversized content before chunking or embedding', async () => {
    const service = new BaseKnowledgeVectorizationService()

    await expect(
      service.vectorize({
        documentId: 'doc-1',
        content: 'x'.repeat(MAX_CONTENT_BYTES + 1),
        type: 'text',
        embeddingModel: 'openai/text-embedding-3-small'
      })
    ).rejects.toMatchObject({ status: 413, code: 'CONTENT_TOO_LARGE' })
    expect(mocks.embedMany).not.toHaveBeenCalled()
  })

  it('rejects empty chunk output', async () => {
    mocks.chunk.mockResolvedValue([])
    const service = new BaseKnowledgeVectorizationService()

    await expect(
      service.vectorize({
        documentId: 'doc-1',
        content: 'content',
        type: 'text',
        embeddingModel: 'openai/text-embedding-3-small'
      })
    ).rejects.toMatchObject({ status: 422, code: 'EMPTY_DOCUMENT' })
  })
})

