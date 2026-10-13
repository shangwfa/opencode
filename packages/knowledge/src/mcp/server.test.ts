/**
 * kb-document-search MCP smoke 测试。
 *
 * 不依赖真实 PG/LLM：
 * - stdio 形态用 SDK 的 InMemoryTransport 直连 server，发 initialize + tools/list；
 * - HTTP 形态直接调用 hono handler，验证 GET 405 与 initialize 响应。
 *
 * 注意：services/index.ts 单例实例化时会 fire-and-forget 连接 PG
 * （KeywordSearchService.initFullTextSearch），因此按工程惯例 mock 掉 services；
 * 同时先设 KNOWLEDGE_DATABASE_URL 假值，防止 db/index.ts 在空 URL 时 import 抛错。
 */
import { describe, test, expect, mock } from 'bun:test'
import { Hono } from 'hono'

process.env['KNOWLEDGE_DATABASE_URL'] =
  process.env['KNOWLEDGE_DATABASE_URL'] || 'postgresql://localhost:5432/knowledge_mcp_smoke'

// 检索链路依赖在 smoke 中不触库：mock services/index（单例构造即连 PG）
mock.module('../rag/knowledge-base/index.js', () => ({
  vectorService: {},
  keywordSearchService: {},
  documentService: {},
  knowledgeBaseService: {
    listKnowledgeBases: () => Promise.resolve({ items: [], total: 0, page: 1, pageSize: 100, totalPages: 0 }),
    getDocument: () => Promise.resolve(null)
  },
  hybridSearchService: {
    search: () => Promise.resolve([])
  },
  recallService: {},
  rerankService: {},
  yddocApiService: {},
  syncTaskService: {},
  documentSyncService: {}
}))

const { createKbDocumentSearchMcpServer, KB_DOCUMENT_SEARCH_SERVER_INFO } = await import('./kb-document-search-server.js'
)
const { mountMcpRoutes } = await import('./http.js')
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')

describe('kb-document-search mcp server', () => {
  test('initialize + tools/list 返回 search_yddoc_documents 工具清单', async () => {
    const server = createKbDocumentSearchMcpServer()
    const client = new Client({ name: 'smoke-client', version: '1.0.0' })

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    try {
      const tools = await client.listTools()

      expect(tools.tools).toHaveLength(1)
      const tool = tools.tools[0]!
      expect(tool.name).toBe('search_yddoc_documents')
      expect(tool.description).toBe(
        '搜索 YYDoc 知识库并返回文档片段、来源元数据和媒体 URL；可按调用请求动态指定知识库与返回字段。'
      )

      // 入参 schema 与源对齐：query 必填，outputOptions 裁剪选项存在
      const properties = (tool.inputSchema as any).properties ?? {}
      expect(Object.keys(properties).sort()).toEqual(
        ['knowledgeBaseIds', 'knowledgeBaseNames', 'outputOptions', 'query', 'topK'].sort()
      )
      expect((tool.inputSchema as any).required).toEqual(['query'])
      expect(Object.keys(properties.outputOptions?.properties ?? {}).sort()).toEqual(
        ['includeMedia', 'includeMetadata', 'includeRetrievalDebug', 'includeText', 'metadataFields'].sort()
      )
    } finally {
      await client.close()
      await server.close()
    }
  })

  test('HTTP：GET 返回 405（stateless 不支持 SSE 长连接）', async () => {
    const app = new Hono()
    mountMcpRoutes(app)

    const res = await app.request('/mcp/kb-document-search', { method: 'GET' })
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('POST')
  })

  test('HTTP：POST initialize 返回 serverInfo（Streamable HTTP stateless）', async () => {
    const app = new Hono()
    mountMcpRoutes(app)

    const res = await app.request('/mcp/kb-document-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'smoke-client', version: '1.0.0' }
        }
      })
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.jsonrpc).toBe('2.0')
    expect(body.result?.serverInfo?.name).toBe(KB_DOCUMENT_SEARCH_SERVER_INFO.name)
    expect(body.result?.serverInfo?.version).toBe(KB_DOCUMENT_SEARCH_SERVER_INFO.version)
  })
})
