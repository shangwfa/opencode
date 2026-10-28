/**
 * Graph HTTP 契约 E2E：/api/graph 四端点（ingest/delete/search/stats）。
 *
 * 前置：DATABASE_URL（PG）；LLM 走环境配置（.env 默认 OpenRouter gpt-6-luna，快且便宜）。
 * 未配置 DATABASE_URL 自动 skip。写入仅使用随机图 KB，结束清理。
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Pool } from 'pg'
import { getDatabaseSchema } from '../src/config/env.js'

const enabled = Boolean(process.env.DATABASE_URL || process.env.KNOWLEDGE_DATABASE_URL)
const KB = `graph_http_contract_${Date.now().toString(36)}`

describe.skipIf(!enabled)('Graph HTTP 契约', () => {
  let app: import('hono').Hono
  let pool: Pool
  const schema = getDatabaseSchema()
  const DOC = 'http-contract-doc-1'

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL || process.env.KNOWLEDGE_DATABASE_URL!
    const { createKnowledgeApp } = await import('../src/app.js')
    app = await createKnowledgeApp({ initDatabase: false })
    pool = new Pool({ connectionString: process.env.DATABASE_URL })
  })

  afterAll(async () => {
    if (pool) {
      await pool.query(`DELETE FROM ${schema}.graph_document_nodes WHERE document_id = $1`, [DOC])
      await pool.query(`DELETE FROM ${schema}.graph_nodes WHERE knowledge_base_id = $1`, [KB])
      await pool.query(`DELETE FROM ${schema}.graph_edges WHERE knowledge_base_id = $1`, [KB])
      await pool.end()
    }
  })

  it('GET /api/graph/stats：返回结构化统计', async () => {
    const res = await app.request(`/api/graph/stats?knowledgeBaseId=${KB}`)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.data.nodes).toBe(0)
    expect(Array.isArray(body.data.topNodeTypes)).toBe(true)
  })

  it('GET /api/graph/stats 缺参 400', async () => {
    const res = await app.request('/api/graph/stats')
    expect(res.status).toBe(400)
  })

  it('POST /api/graph/ingest 校验失败 400（缺 documentId）', async () => {
    const res = await app.request('/api/graph/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ knowledgeBaseId: KB, content: '测试' }),
    })
    expect(res.status).toBe(400)
  })

  it('POST /api/graph/ingest 摄入成功 + PG 落图 + 可检索 + 可删除', async () => {    // ① 摄入（真实 LLM；短文本单 chunk）
    const ingestRes = await app.request('/api/graph/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        knowledgeBaseId: KB,
        documentId: DOC,
        type: 'markdown',
        content: '# MCP 配置\n\nRemote 服务需要填写 Remote URL 和 Headers。Local 服务需要填写启动命令、参数和环境变量。',
        extractTimeoutMs: 120_000,
      }),
    })
    const ingestBody = await ingestRes.json()
    expect(ingestRes.status).toBe(200)
    expect(ingestBody.success).toBe(true)
    expect(ingestBody.data.mode).toBe('llm')
    expect(ingestBody.data.chunkCount).toBeGreaterThanOrEqual(1)
    expect(ingestBody.data.nodeCount).toBeGreaterThan(0)

    // ② PG 断言：文档关联与边来源
    const { rows: linked } = await pool.query(
      `SELECT count(*)::int AS n FROM ${schema}.graph_document_nodes WHERE document_id = $1`, [DOC])
    expect(linked[0].n).toBeGreaterThan(0)
    const { rows: sourced } = await pool.query(
      `SELECT count(*)::int AS n FROM ${schema}.graph_edges
       WHERE knowledge_base_id = $1 AND properties->'sourceDocumentIds' ? $2`, [KB, DOC])
    expect(sourced[0].n).toBeGreaterThan(0)

    // ③ 检索：契约结构 + 命中
    const searchRes = await app.request('/api/graph/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '远程 MCP 服务需要填什么？', knowledgeBaseId: KB, topK: 6 }),
    })
    const searchBody = await searchRes.json()
    expect(searchRes.status).toBe(200)
    expect(searchBody.success).toBe(true)
    expect(Array.isArray(searchBody.data.triplets)).toBe(true)
    expect(searchBody.data.triplets.length).toBeGreaterThan(0)
    expect(searchBody.data.explanation.durationMs).toBeGreaterThan(0)
    const joined = JSON.stringify(searchBody.data)
    expect(joined).toContain('Remote')

    // ④ 删除：unowned 清空 + 关联清理
    const delRes = await app.request(`/api/graph/document/${DOC}?knowledgeBaseId=${KB}`, { method: 'DELETE' })
    const delBody = await delRes.json()
    expect(delRes.status).toBe(200)
    expect(delBody.data.deletedNodeIds.length).toBeGreaterThan(0)
    const stats = await (await app.request(`/api/graph/stats?knowledgeBaseId=${KB}`)).json()
    expect(stats.data.nodes).toBe(0)
    expect(stats.data.edges).toBe(0)
  }, 180_000)

  it('POST /api/graph/search 校验失败 400（空 query）', async () => {
    const res = await app.request('/api/graph/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '' }),
    })
    expect(res.status).toBe(400)
  })
})
