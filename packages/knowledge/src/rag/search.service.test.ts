import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { BaseKnowledgeError } from './errors.js'

const mocks = {
  embed: mock(),
  openaiEmbedding: mock(() => ({ modelId: 'test' }))
}

mock.module('ai', () => ({ embed: mocks.embed, embedMany: mock() }))
mock.module('../providers/llm.js', () => ({
  openaiEmbedding: mocks.openaiEmbedding
}))

const { BaseKnowledgeSearchService } = await import('./search.service.js')

const keywordItem = {
  id: 'doc-1_0',
  documentId: 'doc-1',
  chunkIndex: 0,
  text: 'keyword result',
  score: 1,
  metadata: {}
}

const vectorItem = {
  id: 'doc-2_0',
  documentId: 'doc-2',
  chunkIndex: 0,
  text: 'vector result',
  score: 0.8,
  metadata: {}
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    query: 'query',
    mode: 'hybrid' as const,
    topK: 10,
    timeoutMs: 10,
    failOnPartialTimeout: false,
    excludeDocumentIds: [],
    ...overrides
  }
}

describe('BaseKnowledgeSearchService', () => {
  beforeEach(() => {
    mock.clearAllMocks()
    mocks.embed.mockResolvedValue({ embedding: [0.1, 0.2] })
  })

  it('fuses successful keyword and vector branches', async () => {
    const repository = {
      getSpace: mock().mockResolvedValue({
        knowledgeBaseId: 'kb-1',
        embeddingModel: 'openai/text-embedding-3-small',
        embeddingDimension: 2,
        indexName: 'bk_test'
      }),
      keywordSearch: mock().mockResolvedValue([keywordItem]),
      vectorSearch: mock().mockResolvedValue([vectorItem])
    }
    const service = new BaseKnowledgeSearchService(repository as any)

    const result = await service.search('kb-1', request())

    expect(result.degraded).toBe(false)
    expect(result.items.map((item) => item.documentId)).toEqual(['doc-1', 'doc-2'])
    expect(result.branches.keyword.status).toBe('success')
    expect(result.branches.vector.status).toBe('success')
  })

  it('returns the available branch when the other branch times out', async () => {
    const repository = {
      getSpace: mock().mockResolvedValue({
        knowledgeBaseId: 'kb-1',
        embeddingModel: 'openai/text-embedding-3-small',
        embeddingDimension: 2,
        indexName: 'bk_test'
      }),
      keywordSearch: mock(() => new Promise(() => undefined)),
      vectorSearch: mock().mockResolvedValue([vectorItem])
    }
    const service = new BaseKnowledgeSearchService(repository as any)

    const result = await service.search('kb-1', request())

    expect(result.degraded).toBe(true)
    expect(result.items).toHaveLength(1)
    expect(result.branches.keyword.status).toBe('timeout')
  })

  it('returns 504 when one branch times out and the other is empty', async () => {
    const repository = {
      getSpace: mock().mockResolvedValue({
        knowledgeBaseId: 'kb-1',
        embeddingModel: 'openai/text-embedding-3-small',
        embeddingDimension: 2,
        indexName: 'bk_test'
      }),
      keywordSearch: mock(() => new Promise(() => undefined)),
      vectorSearch: mock().mockResolvedValue([])
    }
    const service = new BaseKnowledgeSearchService(repository as any)

    await expect(service.search('kb-1', request())).rejects.toMatchObject({
      status: 504,
      code: 'SEARCH_TIMEOUT'
    })
  })

  it('returns 504 on any partial timeout in strict mode', async () => {
    const repository = {
      getSpace: mock().mockResolvedValue({
        knowledgeBaseId: 'kb-1',
        embeddingModel: 'openai/text-embedding-3-small',
        embeddingDimension: 2,
        indexName: 'bk_test'
      }),
      keywordSearch: mock(() => new Promise(() => undefined)),
      vectorSearch: mock().mockResolvedValue([vectorItem])
    }
    const service = new BaseKnowledgeSearchService(repository as any)

    await expect(
      service.search('kb-1', request({ failOnPartialTimeout: true }))
    ).rejects.toMatchObject({
      status: 504,
      code: 'PARTIAL_SEARCH_TIMEOUT'
    })
  })

  it('maps a single-mode timeout to HTTP 504 semantics', async () => {
    const repository = {
      keywordSearch: mock(() => new Promise(() => undefined))
    }
    const service = new BaseKnowledgeSearchService(repository as any)

    await expect(
      service.search('kb-1', request({ mode: 'keyword' }))
    ).rejects.toEqual(expect.any(BaseKnowledgeError))
    await expect(
      service.search('kb-1', request({ mode: 'keyword' }))
    ).rejects.toMatchObject({ status: 504, code: 'SEARCH_TIMEOUT' })
  })

  it('does not hide operational failures as degraded search', async () => {
    const repository = {
      getSpace: mock().mockResolvedValue({
        knowledgeBaseId: 'kb-1',
        embeddingModel: 'openai/text-embedding-3-small',
        embeddingDimension: 2,
        indexName: 'bk_test'
      }),
      keywordSearch: mock().mockRejectedValue(new Error('database unavailable')),
      vectorSearch: mock().mockResolvedValue([vectorItem])
    }
    const service = new BaseKnowledgeSearchService(repository as any)

    await expect(service.search('kb-1', request())).rejects.toThrow('database unavailable')
  })
})

