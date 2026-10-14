/**
 * Graph E2E using the existing RAG Harness knowledge-base documents as read-only source data.
 * Opt-in: KNOWLEDGE_GRAPH_RAG_E2E=1 DATABASE_URL=... bun test src/graph/e2e/rag-corpus.e2e.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Pool } from 'pg'
import { getDatabaseSchema } from '../../config/env.js'
import { GraphBuilder } from '../extraction/graph-builder.js'
import { PgGraphAdapter } from '../pg-adapter/adapter.js'
import { UnifiedStoreEngine } from '../unified/engine.js'

const RAG_KB = 'kb_yingdao_harness_zh_cn'
const SOURCE_IDS = [
  '994499662063226880', // 会话复制
  '987902908331687936', // Skill配置
  '987903017838411776', // MCP配置
]
const GRAPH_SCHEMA = 'test_graph_rag_corpus'
const GRAPH_KB = 'rag_corpus_graph_e2e'

type RagDocument = {
  id: string
  content: string
  metadata: { docName?: string; docUrl?: string; [key: string]: unknown }
}

function collectTiptapText(value: unknown): string {
  if (Array.isArray(value)) return value.map(collectTiptapText).join(' ')
  if (!value || typeof value !== 'object') return ''
  const node = value as Record<string, unknown>
  if (node.type === 'text' && typeof node.text === 'string') return node.text
  return Object.values(node).map(collectTiptapText).join(' ')
}

function parseDocumentText(content: string): string {
  try {
    return collectTiptapText(JSON.parse(content))
  } catch {
    return content
  }
}

const enabled = Boolean(process.env.DATABASE_URL) && process.env.KNOWLEDGE_GRAPH_RAG_E2E === '1'

describe.skipIf(!enabled)('Graph E2E：RAG 真实文档只读数据源', () => {
  let pool: Pool
  let adapter: PgGraphAdapter

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL })
    adapter = new PgGraphAdapter(pool, GRAPH_SCHEMA, 64)
    await adapter.init()
  })

  afterAll(async () => {
    if (adapter) await adapter.deleteGraph()
    if (pool) await pool.end()
  })

  it('从 RAG 影刀 Harness 文档读取原文，构建有来源关联的图且不修改源库', async () => {
    const sourceSchema = getDatabaseSchema()
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(sourceSchema)) {
      throw new Error(`非法数据库 schema 名称：${sourceSchema}`)
    }

    const before = await pool.query<{ id: string; content_hash: string }>(
      `SELECT id, md5(content) AS content_hash
       FROM ${sourceSchema}.documents
       WHERE knowledge_base_id = $1 AND id = ANY($2::varchar[])
       ORDER BY id`,
      [RAG_KB, SOURCE_IDS]
    )
    expect(before.rows.map((row) => row.id).sort()).toEqual([...SOURCE_IDS].sort())

    const source = await pool.query<RagDocument>(
      `SELECT id, content, metadata
       FROM ${sourceSchema}.documents
       WHERE knowledge_base_id = $1 AND id = ANY($2::varchar[])
       ORDER BY id`,
      [RAG_KB, SOURCE_IDS]
    )
    const docs = new Map(source.rows.map((row) => [row.id, row]))
    const sessionDoc = docs.get('994499662063226880')!
    const skillDoc = docs.get('987902908331687936')!
    const mcpDoc = docs.get('987903017838411776')!
    expect(sessionDoc.metadata.docName).toBe('会话复制')
    expect(skillDoc.metadata.docName).toBe('Skill配置')
    expect(mcpDoc.metadata.docName).toBe('MCP配置')

    const sessionText = parseDocumentText(sessionDoc.content)
    const skillText = parseDocumentText(skillDoc.content)
    const mcpText = parseDocumentText(mcpDoc.content)
    // 期望事实先行：固定抽取断言必须能在 RAG 原文中找到证据。
    expect(sessionText).toContain('继承当前会话中已经沉淀的背景信息')
    expect(skillText).toContain('配置可复用的任务能力')
    expect(mcpText).toContain('配置可加载的 MCP 能力')

    await adapter.deleteGraph(GRAPH_KB)
    const builder = new GraphBuilder(adapter)
    await builder.buildFromExtraction({
      entities: [{ name: '复制会话', type: 'feature' }, { name: '背景信息', type: 'concept' }],
      triplets: [{ source: '复制会话', relation: '继承', target: '背景信息', confidence: 0.9 }],
    }, { knowledgeBaseId: GRAPH_KB, documentId: sessionDoc.id, buildEntityTypeNodes: false })
    await builder.buildFromExtraction({
      entities: [{ name: 'Skill配置', type: 'feature' }, { name: '可复用任务能力', type: 'concept' }],
      triplets: [{ source: 'Skill配置', relation: '配置', target: '可复用任务能力', confidence: 0.9 }],
    }, { knowledgeBaseId: GRAPH_KB, documentId: skillDoc.id, buildEntityTypeNodes: false })
    await builder.buildFromExtraction({
      entities: [{ name: 'MCP配置', type: 'feature' }, { name: '可加载MCP能力', type: 'concept' }],
      triplets: [{ source: 'MCP配置', relation: '配置', target: '可加载MCP能力', confidence: 0.9 }],
    }, { knowledgeBaseId: GRAPH_KB, documentId: mcpDoc.id, buildEntityTypeNodes: false })

    const graph = await adapter.getGraphData(GRAPH_KB)
    expect(graph.nodes).toHaveLength(6)
    expect(graph.edges).toHaveLength(3)
    expect(graph.edges.map((edge) => edge.relationshipName).sort()).toEqual(['继承', '配置', '配置'])
    for (const id of SOURCE_IDS) {
      expect(await adapter.getNodeIdsByDocument(id)).toHaveLength(2)
    }

    const after = await pool.query<{ id: string; content_hash: string }>(
      `SELECT id, md5(content) AS content_hash
       FROM ${sourceSchema}.documents
       WHERE knowledge_base_id = $1 AND id = ANY($2::varchar[])
       ORDER BY id`,
      [RAG_KB, SOURCE_IDS]
    )
    expect(after.rows).toEqual(before.rows)
  })

  it('将 RAG 知识库全量 36 篇文档映射为文档-目录图并验证删除隔离', async () => {
    const sourceSchema = getDatabaseSchema()
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(sourceSchema)) {
      throw new Error(`非法数据库 schema 名称：${sourceSchema}`)
    }
    const before = await pool.query<{ id: string; content_hash: string }>(
      `SELECT id, md5(content) AS content_hash
       FROM ${sourceSchema}.documents
       WHERE knowledge_base_id = $1
       ORDER BY id`,
      [RAG_KB]
    )
    expect(before.rows).toHaveLength(36)

    const docs = await pool.query<RagDocument>(
      `SELECT id, content, metadata
       FROM ${sourceSchema}.documents
       WHERE knowledge_base_id = $1
       ORDER BY id`,
      [RAG_KB]
    )
    expect(docs.rows).toHaveLength(36)
    expect(docs.rows.every((doc) => doc.metadata.docName && doc.metadata.parentPath)).toBe(true)

    await adapter.deleteGraph(GRAPH_KB)
    const builder = new GraphBuilder(adapter)
    for (const doc of docs.rows) {
      await builder.buildFromExtraction({
        entities: [
          { name: `文档:${doc.metadata.docName}`, type: 'document' },
          { name: `目录:${doc.metadata.parentPath}`, type: 'document_category' },
        ],
        triplets: [{
          source: `文档:${doc.metadata.docName}`,
          relation: '归属目录',
          target: `目录:${doc.metadata.parentPath}`,
          confidence: 1,
        }],
      }, {
        knowledgeBaseId: GRAPH_KB,
        documentId: doc.id,
        buildEntityTypeNodes: false,
      })
    }

    const graph = await adapter.getGraphData(GRAPH_KB)
    expect(graph.nodes.filter((node) => node.type === 'document')).toHaveLength(36)
    expect(graph.nodes.filter((node) => node.type === 'document_category')).toHaveLength(13)
    expect(graph.edges).toHaveLength(36)
    for (const doc of docs.rows) {
      expect(await adapter.getNodeIdsByDocument(doc.id)).toHaveLength(2)
    }

    // 删除单篇来源只移除其文档节点和边；共享目录节点及其他文档仍保留。
    const removedDoc = docs.rows[0]
    await new UnifiedStoreEngine(adapter, undefined, GRAPH_SCHEMA).deleteByDocument(removedDoc.id, GRAPH_KB)
    const afterDelete = await adapter.getGraphData(GRAPH_KB)
    expect(afterDelete.nodes.filter((node) => node.type === 'document')).toHaveLength(35)
    expect(afterDelete.nodes.filter((node) => node.type === 'document_category')).toHaveLength(13)
    expect(afterDelete.edges).toHaveLength(35)
    expect(await adapter.getNodeIdsByDocument(removedDoc.id)).toHaveLength(0)

    const after = await pool.query<{ id: string; content_hash: string }>(
      `SELECT id, md5(content) AS content_hash
       FROM ${sourceSchema}.documents
       WHERE knowledge_base_id = $1
       ORDER BY id`,
      [RAG_KB]
    )
    expect(after.rows).toEqual(before.rows)
  })
})
