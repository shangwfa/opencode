import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { Hono } from 'hono'

const serviceMocks = {
  createDocument: mock(),
  ingestApiSpec: mock(),
  updateDocument: mock(),
  deleteDocument: mock(),
  deleteKnowledgeBase: mock(),
  search: mock()
}

mock.module('./services.js', () => ({
  baseKnowledgeService: {
    createDocument: serviceMocks.createDocument,
    updateDocument: serviceMocks.updateDocument,
    deleteDocument: serviceMocks.deleteDocument,
    deleteKnowledgeBase: serviceMocks.deleteKnowledgeBase
  },
  baseKnowledgeApiSpecService: {
    ingest: serviceMocks.ingestApiSpec
  },
  baseKnowledgeSearchService: {
    search: serviceMocks.search
  }
}))

const { baseKnowledgeApp } = await import('./routes.js')

// 与 app.ts 相同的挂载方式：'/base-knowledge' 前缀下挂载子应用
const app = new Hono().route('/base-knowledge', baseKnowledgeApp)

async function dispatch(method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
}

describe('Base Knowledge /api route dispatch', () => {
  beforeEach(() => {
    mock.clearAllMocks()
  })

  it('dispatches an /api document create request with its knowledge base id', async () => {
    const createdAt = new Date('2026-01-01')
    serviceMocks.createDocument.mockResolvedValue({
      knowledgeBaseId: 'kb-001',
      documentId: 'doc-001',
      type: 'tiptap',
      chunkCount: 1,
      version: 1,
      createdAt,
      updatedAt: createdAt
    })
    const body = {
      documentId: 'doc-001',
      type: 'tiptap',
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: '文档内容' }] }]
      }
    }

    const response = await dispatch('POST', '/base-knowledge/kb-001/documents', body)

    expect(serviceMocks.createDocument).toHaveBeenCalledWith('kb-001', body)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ success: true })
  })

  it('dispatches document update and delete requests to the same handlers', async () => {
    const updatedAt = new Date('2026-01-02')
    serviceMocks.updateDocument.mockResolvedValue({
      knowledgeBaseId: 'kb-001',
      documentId: 'doc-001',
      type: 'markdown',
      chunkCount: 2,
      version: 2,
      createdAt: updatedAt,
      updatedAt
    })

    await dispatch('PUT', '/base-knowledge/kb-001/documents/doc-001', {
      type: 'markdown',
      content: '# updated'
    })
    await dispatch('DELETE', '/base-knowledge/kb-001/documents/doc-001')

    expect(serviceMocks.updateDocument).toHaveBeenCalledWith('kb-001', 'doc-001', {
      type: 'markdown',
      content: '# updated'
    })
    expect(serviceMocks.deleteDocument).toHaveBeenCalledWith('kb-001', 'doc-001')
  })

  it('does not match unrelated paths', async () => {
    const response = await dispatch('GET', '/health')

    expect(response.status).toBe(404)
  })

  it('dispatches API specification ingestion to the graph pipeline', async () => {
    serviceMocks.ingestApiSpec.mockResolvedValue({
      format: 'openapi', operationCount: 1, succeeded: 1, results: []
    })
    const spec = { openapi: '3.0.1', paths: {} }
    const response = await dispatch('POST', '/base-knowledge/kb-001/api-spec', {
      documentId: 'api-spec-001', content: spec, prefix: '/oapi/'
    })

    expect(serviceMocks.ingestApiSpec).toHaveBeenCalledWith('kb-001', 'api-spec-001', spec, { prefix: '/oapi/', limit: undefined })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ success: true })
  })
})
