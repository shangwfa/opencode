/**
 * 端到端测试：HTTP 接口全链路（创建知识库 → 文档入库/分块/向量化 → 检索 → 更新 → 删除）。
 *
 * 依赖：
 * - PostgreSQL（含 pgvector + pg_trgm），由 KNOWLEDGE_DATABASE_URL 指定（未设置时整个套件 skip）
 * - LLM/Embedding 通过 mock.module('ai') 注入确定性伪向量，不访问外网
 *
 * 运行：
 *   KNOWLEDGE_DATABASE_URL=postgresql://... bun test test/e2e.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import type { Pool } from "pg"
import { createOwnedTestSchema } from "./helpers/owned-schema.js"

const EMBED_DIM = 1536

/** bag-of-tokens 确定性伪向量：文本重叠越多 cosine 相似度越高 */
function pseudoEmbedding(text: string): number[] {
  const vec = new Array<number>(EMBED_DIM).fill(0)
  for (const token of text.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean)) {
    let h = 2166136261
    for (let i = 0; i < token.length; i++) {
      h ^= token.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    vec[Math.abs(h) % EMBED_DIM] += 1
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1
  return vec.map((v) => v / norm)
}

mock.module("ai", () => ({
  embed: async ({ value }: any) => ({ embedding: pseudoEmbedding(String(value)) }),
  embedMany: async ({ values }: any) => ({ embeddings: values.map((v: any) => pseudoEmbedding(String(v))) }),
  // 伪相关性打分：按 LLMRelevanceScorer 的 prompt 结构提取查询与文档块，
  // 用词法重叠模拟 1.0（直接回答）/0.5（部分相关）/0.0（无关）三档语义，
  // 保证 rerank 'llm' 默认路径在测试中有区分度（恒 0.9 会让排序退化为输入序）
  generateText: async ({ prompt }: any) => {
    const m = String(prompt ?? "").match(/用户查询：\n([\s\S]*?)\n\n文档块：\n([\s\S]*?)\n\n相关性分数/)
    if (!m) return { text: "0.0", finishReason: "stop", usage: {} }
    const query = m[1]!.trim()
    const doc = m[2]!.trim()
    if (!query || !doc) return { text: "0.0", finishReason: "stop", usage: {} }
    if (doc.includes(query)) return { text: "0.9", finishReason: "stop", usage: {} }
    const qChars = new Set(query)
    const hit = [...doc].filter((ch) => qChars.has(ch)).length / Math.max(query.length, 1)
    return { text: hit > 0.8 ? "0.5" : "0.0", finishReason: "stop", usage: {} }
  },
  generateObject: async () => ({ object: {} }),
  streamText: async () => ({}),
}))

const databaseUrl = process.env["KNOWLEDGE_DATABASE_URL"] || ""
const describeE2E = databaseUrl ? describe : describe.skip

describeE2E("knowledge base e2e", () => {
  const testSchema = createOwnedTestSchema("rag")
  let pool: Pool | undefined
  let stopRecovery: (() => void) | undefined
  let app: any
  let base: string
  let kbId: string
  let docId: string

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`${base}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
    const json = await res.json().catch(() => null)
    return { status: res.status, json }
  }

  beforeAll(async () => {
    process.env["KNOWLEDGE_DATABASE_SCHEMA"] = testSchema.name
    const database = await import("../src/db/index.js")
    await testSchema.prepare(database.pool, database.schemaName)
    pool = database.pool
    const { wikiCompilerService } = await import("../src/llm-wiki/services/index.js")
    stopRecovery = () => wikiCompilerService.stopRecovery()
    const { createKnowledgeApp } = await import("../src/app.js")
    app = await createKnowledgeApp()
    base = "/api"
  })

  afterAll(async () => {
    if (!pool) return
    stopRecovery?.()
    try {
      await testSchema.cleanup(pool)
    } finally {
      await pool.end()
    }
  })

  test("health", async () => {
    const { status, json } = await call("GET", "/../health")
    expect(status).toBe(200)
    expect(json.success).toBe(true)
  })

  test("创建知识库", async () => {
    const { status, json } = await call("POST", "/knowledge-base", {
      id: "e2e-kb",
      name: "E2E 知识库",
      description: "端到端测试",
      defaultChunkStrategy: "recursive",
    })
    expect(status).toBe(200)
    expect(json.success).toBe(true)
    expect(json.data.id).toBe("e2e-kb")
    kbId = json.data.id

    // PG 数据校验
    const { pool, schemaName } = await import("../src/db/index.js")
    const row = await pool.query(`SELECT * FROM ${schemaName}.knowledge_bases WHERE id = $1`, [kbId])
    expect(row.rows.length).toBe(1)
    expect(row.rows[0].embedding_model).toContain("text-embedding")
  })

  test("添加文档（分块+向量化）", async () => {
    const content = [
      "# 指南",
      "",
      "## 安装",
      "使用 bun install 安装依赖包。",
      "",
      "## 配置",
      "配置数据库连接字符串以启用存储。",
      "",
      "## 检索",
      "向量检索与关键词检索可以混合融合。",
    ].join("\n")
    const { status, json } = await call("POST", `/knowledge-base/${kbId}/documents`, {
      id: "e2e-doc",
      content,
      type: "markdown",
      chunkStrategy: "recursive",
      chunkConfig: { maxSize: 64, overlap: 8 },
    })
    expect(status).toBe(200)
    expect(json.success).toBe(true)
    expect(json.data.chunkCount).toBeGreaterThan(0)
    docId = json.data.id

    // PG 数据校验：documents 表 + 向量表
    const { pool, schemaName } = await import("../src/db/index.js")
    const doc = await pool.query(`SELECT * FROM ${schemaName}.documents WHERE id = $1`, [docId])
    expect(doc.rows[0].status).toBe("completed")

    const vectorTable = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ${schemaName}.kb_e2e_kb WHERE metadata->>'documentId' = $1`,
      [docId],
    )
    expect(vectorTable.rows[0].n).toBe(json.data.chunkCount)
  })

  test("chunk 列表", async () => {
    const { status, json } = await call("GET", `/knowledge-base/${kbId}/documents/${docId}/chunks`)
    expect(status).toBe(200)
    expect(json.data.chunkCount).toBeGreaterThan(0)
    expect(json.data.chunks.length).toBe(json.data.chunkCount)
    expect(typeof json.data.chunks[0].text).toBe("string")
  })

  test("语义检索", async () => {
    const { status, json } = await call("POST", `/knowledge-base/${kbId}/search`, {
      query: "配置数据库连接",
      searchType: "semantic",
      topK: 5,
    })
    expect(status).toBe(200)
    expect(json.success).toBe(true)
    expect(json.data.results.length).toBeGreaterThan(0)
    const top = json.data.results[0]
    expect(top.score).toBeGreaterThan(0)
    expect(top.text ?? top.metadata?.text ?? "").toContain("配置")
  })

  test("关键词检索", async () => {
    const { status, json } = await call("POST", `/knowledge-base/${kbId}/search`, {
      query: "bun install",
      searchType: "keyword",
      topK: 5,
      recallConfig: { enableMultiStage: false },
    })
    expect(status).toBe(200)
    expect(json.data.results.length).toBeGreaterThan(0)
  })

  test("混合检索 + metadata 过滤", async () => {
    const { status, json } = await call("POST", `/knowledge-base/${kbId}/search`, {
      query: "检索融合",
      searchType: "hybrid",
      topK: 5,
      filter: { documentId: docId },
      recallConfig: { enableMultiStage: false },
    })
    expect(status).toBe(200)
    for (const item of json.data.results) {
      expect(item.metadata?.documentId ?? item.documentId).toBe(docId)
    }
  })

  test("元信息检索（searchType=metadata，纯 filter 召回，无需 query）", async () => {
    // metadata 模式 filter 必填
    const r1 = await call("POST", `/knowledge-base/${kbId}/search`, { searchType: "metadata" })
    expect(r1.status).toBe(400)

    // filter 命中：仅返回目标文档的块
    const r2 = await call("POST", `/knowledge-base/${kbId}/search`, {
      searchType: "metadata",
      topK: 5,
      filter: { documentId: docId },
    })
    expect(r2.status).toBe(200)
    expect(r2.json.data.results.length).toBeGreaterThan(0)
    for (const item of r2.json.data.results) {
      expect(item.metadata?.documentId ?? item.documentId).toBe(docId)
    }

    // 无匹配 filter → 0 条（而非错误）
    const r3 = await call("POST", `/knowledge-base/${kbId}/search`, {
      searchType: "metadata",
      topK: 5,
      filter: { documentId: "no-such-doc" },
    })
    expect(r3.status).toBe(200)
    expect(r3.json.data.results.length).toBe(0)

    // 其它检索类型缺 query 仍 400（防回归）
    const r4 = await call("POST", `/knowledge-base/${kbId}/search`, {
      searchType: "semantic",
      filter: { documentId: docId },
    })
    expect(r4.status).toBe(400)
  })

  test("文档列表 metadata 筛选（管理面元查询）", async () => {
    // 文档级 metadata（documents.metadata，与 chunk 级 metadata 分层）：仅更新元数据不触发重处理
    await call("PUT", `/knowledge-base/${kbId}/documents/${docId}`, { metadata: { team: "uc-team" } })
    const hit = encodeURIComponent(JSON.stringify({ team: "uc-team" }))
    const miss = encodeURIComponent(JSON.stringify({ team: "no-such" }))
    const r1 = await call("GET", `/knowledge-base/${kbId}/documents?metadata=${hit}`)
    expect(r1.status).toBe(200)
    expect(r1.json.data.items.length).toBe(1)
    const r2 = await call("GET", `/knowledge-base/${kbId}/documents?metadata=${miss}`)
    expect(r2.status).toBe(200)
    expect(r2.json.data.items.length).toBe(0)
    const r3 = await call("GET", `/knowledge-base/${kbId}/documents?metadata=not-json`)
    expect(r3.status).toBe(400)
  })

  test("更新文档（重新向量化）", async () => {
    const { status, json } = await call("PUT", `/knowledge-base/${kbId}/documents/${docId}`, {
      content: "# 新指南\n\n## 概览\n这是更新后的内容，讲的是部署与运维。",
    })
    expect(status).toBe(200)
    expect(json.success).toBe(true)

    const { pool, schemaName } = await import("../src/db/index.js")
    const vectorTable = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ${schemaName}.kb_e2e_kb WHERE metadata->>'documentId' = $1`,
      [docId],
    )
    expect(vectorTable.rows[0].n).toBe(json.data.chunkCount)
  })

  test("删除文档（清理向量）", async () => {
    const { status } = await call("DELETE", `/knowledge-base/${kbId}/documents/${docId}`)
    expect(status).toBe(200)

    const { pool, schemaName } = await import("../src/db/index.js")
    const vectorTable = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ${schemaName}.kb_e2e_kb WHERE metadata->>'documentId' = $1`,
      [docId],
    )
    expect(vectorTable.rows[0].n).toBe(0)
  })

  test("删除知识库（级联）", async () => {
    const { status } = await call("DELETE", `/knowledge-base/${kbId}`)
    expect(status).toBe(200)

    const { pool, schemaName } = await import("../src/db/index.js")
    const kb = await pool.query(`SELECT * FROM ${schemaName}.knowledge_bases WHERE id = $1`, [kbId])
    expect(kb.rows.length).toBe(0)
  })
})
