/** 独立 Docker HTTP + PG 契约验收，不使用模块 mock；需显式启用。 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { Pool } from "pg"

const enabled = process.env.KNOWLEDGE_DATA_TABLE_HTTP_E2E === "1"
const suite = enabled ? describe : describe.skip
const base = process.env.KNOWLEDGE_DATA_TABLE_BASE_URL ?? "http://127.0.0.1:18887/api"
const schema = process.env.KNOWLEDGE_DATABASE_SCHEMA ?? ""
const datasetId = `rd_phase1_http_${randomUUID().replaceAll("-", "")}`

suite("data-table 检索执行契约：真实 HTTP 与 PG", () => {
  let pool: Pool
  let created = false
  let dataTable: string
  let vectorTable: string
  let before: string

  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method, signal: AbortSignal.timeout(90_000),
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: response.status, json: await response.json() as any }
  }
  const search = (body: unknown) => call("POST", `/database/${datasetId}/rows/search`, body)
  const quote = (name: string) => {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(name)) throw new Error("Invalid test identifier")
    return `"${name}"`
  }
  const snapshot = async () => {
    const metadata = await pool.query(`SELECT * FROM ${quote(schema)}.databases WHERE id=$1`, [datasetId])
    const rows = await pool.query(`SELECT * FROM ${quote(schema)}.${quote(dataTable)} ORDER BY id`)
    const vectors = await pool.query(`SELECT * FROM ${quote(schema)}.${quote(vectorTable)} ORDER BY vector_id`)
    return JSON.stringify({ metadata: metadata.rows, rows: rows.rows, vectors: vectors.rows })
  }

  beforeAll(async () => {
    if (!process.env.KNOWLEDGE_DATABASE_URL || !/^knowledge_dt_[a-z0-9_]+$/.test(schema)) {
      throw new Error("HTTP e2e requires explicit KNOWLEDGE_DATABASE_URL and isolated knowledge_dt_* schema")
    }
    pool = new Pool({ connectionString: process.env.KNOWLEDGE_DATABASE_URL })
    const result = await call("POST", "/database", {
      id: datasetId, name: "检索策略契约验收",
      columns: [{ name: "name" }, { name: "category" }, { name: "body" }],
      dataSource: [
        { name: "支付", category: "交易", body: "对接支付渠道、处理支付回调、退款" },
        { name: "库存", category: "供应链", body: "管理库存数量、库存盘点、出入库" },
        { name: "用户", category: "平台", body: "登录鉴权、权限校验、会话管理" },
      ],
    })
    created = result.status === 200
    expect(result.status).toBe(200)
    expect(result.json.success).toBe(true)
    dataTable = result.json.data.dataTableName
    vectorTable = result.json.data.indexName
    const rows = await pool.query(`SELECT count(*)::int AS count FROM ${quote(schema)}.${quote(dataTable)}`)
    expect(rows.rows[0].count).toBe(3)
    before = await snapshot()
  }, 120_000)

  afterAll(async () => {
    try {
      if (created) {
        const result = await call("DELETE", `/database/${datasetId}`)
        expect(result.status).toBe(200)
        const metadata = await pool.query(`SELECT id FROM ${quote(schema)}.databases WHERE id=$1`, [datasetId])
        expect(metadata.rowCount).toBe(0)
        const tables = await pool.query("SELECT to_regclass($1) AS data, to_regclass($2) AS vector", [
          `${schema}.${dataTable}`, `${schema}.${vectorTable}`,
        ])
        expect(tables.rows[0]).toEqual({ data: null, vector: null })
      }
    } finally {
      await pool?.end()
    }
  })

  for (const fusionMethod of ["weighted", "rrf", "weighted-rrf", "hybrid"]) {
    test(`hybrid 实际执行两路与 ${fusionMethod} 融合`, async () => {
      const result = await search({ query: "处理支付回调", searchType: "hybrid", fusionMethod, topK: 2 })
      expect(result.status).toBe(200)
      const { items, execution } = result.json.data
      expect(items.length).toBeGreaterThan(0)
      expect(items.length).toBeLessThanOrEqual(2)
      expect(items.some((item: any) => item.row.name === "支付")).toBe(true)
      expect(execution.strategy).toBe("hybrid")
      expect(execution.fusionMethod).toBe(fusionMethod)
      expect(execution.branchResults.semantic).toBeGreaterThan(0)
      expect(execution.branchResults.keyword).toBeGreaterThan(0)
      expect(execution.fusionApplied).toBe(true)
    })
  }

  for (const hybridWeight of [{ semantic: 0, keyword: 1 }, { semantic: 1, keyword: 0 }]) {
    test(`HTTP 保留混合权重 ${JSON.stringify(hybridWeight)}`, async () => {
      const result = await search({ query: "处理支付回调", searchType: "hybrid", fusionMethod: "weighted", hybridWeight })
      expect(result.status).toBe(200)
      expect(result.json.data.execution.hybridWeight).toEqual(hybridWeight)
      expect(result.json.data.items.length).toBeGreaterThan(0)
    })
  }

  for (const searchType of ["semantic", "keyword"]) {
    test(`${searchType} 默认路径保持类型`, async () => {
      const result = await search({ query: "处理支付回调", searchType, topK: 2 })
      expect(result.status).toBe(200)
      expect(result.json.data.execution.strategy).toBe(searchType)
      expect(result.json.data.items.length).toBeGreaterThan(0)
    })
  }

  for (const searchType of ["keyword", "hybrid"]) {
    for (const options of [
      { recallConfig: { enableMultiStage: true } },
      { recallConfig: { enableQueryExpansion: true } },
      { hydeConfig: { enableHyDE: true } },
      { multiQueryConfig: { enableMultiQuery: true } },
    ]) {
      test(`${searchType} 显式拒绝未支持增强 ${JSON.stringify(options)}`, async () => {
        const result = await search({ query: "处理支付回调", searchType, ...options })
        expect(result.status).toBe(400)
        expect(result.json.success).toBe(false)
        expect(result.json.data).toBeNull()
      })
    }
  }

  test("全零权重拒绝", async () => {
    const result = await search({ query: "库存", searchType: "hybrid", hybridWeight: { semantic: 0, keyword: 0 } })
    expect(result.status).toBe(400)
    expect(result.json.message).toContain("zero")
  })

  test("过滤空候选不伪报已执行向量检索", async () => {
    const result = await search({ query: "库存", filter: { category: "不存在" }, searchType: "hybrid" })
    expect(result.status).toBe(200)
    expect(result.json.data.items).toEqual([])
    expect(result.json.data.execution.strategy).toBe("none")
  })

  test("纯 SQL 过滤明确执行路径", async () => {
    const result = await search({ filter: { category: "交易" } })
    expect(result.status).toBe(200)
    expect(result.json.data.execution.strategy).toBe("sql-filter")
    expect(result.json.data.items).toHaveLength(1)
  })

  test("GET query 保留数组响应契约", async () => {
    const result = await call("GET", `/database/${datasetId}/query?query=${encodeURIComponent("处理支付回调")}`)
    expect(result.status).toBe(200)
    expect(Array.isArray(result.json.data)).toBe(true)
    expect(result.json.data.length).toBeGreaterThan(0)
  })

  test("查询和校验失败均不改变 PG 元数据、行或向量", async () => {
    expect(await snapshot()).toBe(before)
  })
})
