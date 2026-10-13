/**
 * 数据表（database 表问答/表行检索）端到端测试：
 * 建数据集 → 加行（向量化）→ 语义/过滤检索 → 向量直查 → 删行 → 删数据集。
 *
 * 依赖 KNOWLEDGE_DATABASE_URL（pgvector，未设置时整组 skip）；
 * LLM/Embedding 用确定性伪向量（bag-of-tokens），不访问外网。
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test"

const DIM = 1536
/** bag-of-tokens 确定性伪向量：文本重叠越多 cosine 相似度越高 */
function pseudo(text: string): number[] {
  const vec = new Array<number>(DIM).fill(0)
  for (const tk of String(text).toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean)) {
    let h = 2166136261
    for (let i = 0; i < tk.length; i++) {
      h ^= tk.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    vec[Math.abs(h) % DIM] += 1
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1
  return vec.map((v) => v / norm)
}

mock.module("ai", () => ({
  embed: async ({ value }: any) => ({ embedding: pseudo(value) }),
  embedMany: async ({ values }: any) => ({ embeddings: values.map((v: any) => pseudo(v)) }),
  generateText: async () => ({ text: "0.9" }),
  generateObject: async () => ({ object: {} }),
  streamText: async () => ({}),
}))

const databaseUrl = process.env["KNOWLEDGE_DATABASE_URL"] || ""
const describeE2E = databaseUrl ? describe : describe.skip

describeE2E("database 表检索 e2e", () => {
  let app: any
  let rowId: string

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`/api${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
    return { status: res.status, json: await res.json().catch(() => null) }
  }

  beforeAll(async () => {
    process.env["KNOWLEDGE_DATABASE_SCHEMA"] = process.env["KNOWLEDGE_DATABASE_SCHEMA"] || "knowledge_ds_e2e"
    const { createKnowledgeApp } = await import("../src/app.js")
    app = await createKnowledgeApp()
  })

  afterAll(async () => {
    const { pool } = await import("../src/db/index.js")
    await pool.query(`DROP SCHEMA IF EXISTS "${process.env["KNOWLEDGE_DATABASE_SCHEMA"]}" CASCADE`).catch(() => {})
    await pool.end().catch(() => {})
  })

  test("建数据集（含初始行，自动建动态表+向量索引）", async () => {
    const { status, json } = await call("POST", "/database", {
      id: "ds_e2e",
      name: "冒烟数据集",
      // 故意使用 PG 保留字列名，验证动态表 DDL 引号防护
      columns: [{ name: "title" }, { name: "desc" }],
      dataSource: [
        { title: "订单服务", desc: "处理订单创建与查询的微服务" },
        { title: "库存服务", desc: "管理库存与库存变更" },
      ],
    })
    expect(status).toBe(200)
    expect(json.success).toBe(true)

    // PG 校验：元表 + 动态表存在
    const { pool, schemaName } = await import("../src/db/index.js")
    const meta = await pool.query(`SELECT * FROM ${schemaName}.databases WHERE id = $1`, ["ds_e2e"])
    expect(meta.rows.length).toBe(1)
    const dyn = await pool.query(`SELECT to_regclass('${schemaName}.${meta.rows[0].data_table_name}') AS reg`)
    expect(dyn.rows[0].reg).not.toBeNull()
  })

  test("数据集详情", async () => {
    const { status, json } = await call("GET", "/database/ds_e2e")
    expect(status).toBe(200)
    expect(json.data.name).toBe("冒烟数据集")
  })

  test("加行（写入并向量化，含保留字列名）", async () => {
    const { status, json } = await call("POST", "/database/ds_e2e/rows", {
      rows: [{ title: "消息队列", desc: "传递库存变更消息的队列" }],
    })
    expect(status).toBe(200)
    expect(json.data.count).toBe(1)
    rowId = json.data.rows[0].id
  })

  test("语义检索", async () => {
    const { status, json } = await call("POST", "/database/ds_e2e/rows/search", {
      query: "订单创建",
      searchType: "semantic",
      topK: 3,
    })
    expect(status).toBe(200)
    const items = json.data.results ?? json.data.items
    expect(items.length).toBeGreaterThan(0)
  })

  test("filter 检索（保留字列名过滤）", async () => {
    const { status, json } = await call("POST", "/database/ds_e2e/rows/search", {
      filter: { title: "库存服务" },
      limit: 5,
    })
    expect(status).toBe(200)
    const items = json.data.results ?? json.data.items
    expect(items.length).toBe(1)
    expect(items[0].title ?? items[0].row?.title).toBe("库存服务")
  })

  test("向量直查", async () => {
    const { status, json } = await call("POST", "/database/ds_e2e/vectors/query", {
      queryVector: pseudo("库存变更"),
      topK: 2,
    })
    expect(status).toBe(200)
    expect(json.data.length).toBeGreaterThan(0)
  })

  test("删行（batch 接口，含向量清理）", async () => {
    expect(rowId).toBeTruthy()
    const { status, json } = await call("DELETE", "/database/ds_e2e/rows/batch", { ids: [rowId] })
    expect(status).toBe(200)
    expect(json.data.deleted).toBe(1)
  })

  test("删数据集", async () => {
    const { status } = await call("DELETE", "/database/ds_e2e")
    expect(status).toBe(200)
    const { pool, schemaName } = await import("../src/db/index.js")
    const meta = await pool.query(`SELECT * FROM ${schemaName}.databases WHERE id = $1`, ["ds_e2e"])
    expect(meta.rows.length).toBe(0)
  })
})
