/**
 * 影刀 inner 代理 + yddoc 同步 真实链路 e2e。
 *
 * 覆盖：inner embedding 真实向量化 → sync-from-yydoc（maxDocs=1）→
 * PG 落点（documents / kb_<id> 向量表）→ 语义检索命中。
 *
 * 依赖（缺省整组 skip，不进常规 CI）：
 * - PostgreSQL（pgvector + pg_trgm）：KNOWLEDGE_DATABASE_URL
 * - 影刀内网代理可达：KNOWLEDGE_INNER_E2E=1 显式开启
 *   （内部会设置 KNOWLEDGE_EMBEDDING_CHANNEL=inner 与 XYBOT_* 信封，也可用环境已设值）
 *
 * 运行：
 *   KNOWLEDGE_DATABASE_URL=postgresql://... KNOWLEDGE_INNER_E2E=1 \
 *   XYBOT_AI_BASE_URL=http://xybot-appreciation:8080/api/appreciation/v1 \
 *   XYBOT_USER_HEADER='{"name":"...","tenantUuid":"...","uuid":"..."}' \
 *   PROXY_BIZ_CODE=... PROXY_BIZ_ID=... \
 *   bun test test/sync-inner-e2e.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { embed } from "ai"

const databaseUrl = process.env["KNOWLEDGE_DATABASE_URL"] || ""
const innerReady =
  process.env["KNOWLEDGE_INNER_E2E"] === "1" && Boolean(process.env["XYBOT_AI_BASE_URL"])
const describeE2E = databaseUrl && innerReady ? describe : describe.skip

const SCHEMA = "knowledge_inner_e2e"
const BRAND = process.env["KNOWLEDGE_INNER_E2E_BRAND"] || "yingdao-harness"
const LANGUAGE = process.env["KNOWLEDGE_INNER_E2E_LANG"] || "zh-CN"

process.env["KNOWLEDGE_DATABASE_SCHEMA"] = SCHEMA
process.env["KNOWLEDGE_EMBEDDING_CHANNEL"] = "inner"
process.env["no_proxy"] = [process.env["no_proxy"], "xybot-appreciation"]
  .filter(Boolean)
  .join(",")

describeE2E("sync-from-yydoc × inner proxy（真实链路）", () => {
  let app: any
  let knowledgeBaseId = ""

  beforeAll(async () => {
    const { createKnowledgeApp } = await import("../src/app.js")
    app = await createKnowledgeApp()
  })

  afterAll(async () => {
    const { pool } = await import("../src/db/index.js")
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await pool.end()
  })

  test("inner embedding 返回 1536 维真实向量", async () => {
    const { openaiEmbedding } = await import("../src/providers/llm.js")
    const { embedding } = await embed({
      model: openaiEmbedding(process.env["KNOWLEDGE_DEFAULT_EMBEDDING_MODEL"] || "openai/text-embedding-3-small"),
      value: "影刀 inner 代理 e2e 冒烟",
    })
    expect(embedding).toHaveLength(1536)
    expect(embedding.some((v) => v !== 0)).toBe(true)
  })

  test("sync-from-yydoc 单篇同步完成并可检索", async () => {
    // 1. 触发同步（限 1 篇）
    const syncRes = await app.request("/api/knowledge-base/sync-from-yydoc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ brandCode: BRAND, languageCode: LANGUAGE, name: "inner e2e 同步", maxDocs: 1 }),
    })
    const syncJson = await syncRes.json()
    expect(syncRes.status).toBe(200)
    const taskId = syncJson.data.taskId
    // 以服务端规范化后的 id 为准（normalizeIndexName 会转小写）
    knowledgeBaseId = syncJson.data.knowledgeBaseId

    // 2. 轮询任务至完成（单篇上限 120s）
    let progress: any = null
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 3000))
      const statusRes = await app.request(`/api/knowledge-base/sync-task/${taskId}`)
      const statusJson = await statusRes.json()
      progress = statusJson.data
      if (["completed", "failed"].includes(progress.status)) break
    }
    expect(progress.status).toBe("completed")
    expect(progress.progress.failed).toBe(0)
    expect(progress.progress.success).toBeGreaterThanOrEqual(1)

    // 3. PG 落点：documents completed + 向量表非空
    const { pool } = await import("../src/db/index.js")
    const docCount = await pool.query(
      `SELECT count(*)::int AS n FROM ${SCHEMA}.documents WHERE status = 'completed'`,
    )
    expect(docCount.rows[0].n).toBeGreaterThanOrEqual(1)
    const vectors = await pool.query(
      `SELECT count(*)::int AS n FROM ${SCHEMA}.${knowledgeBaseId}`,
    )
    expect(vectors.rows[0].n).toBeGreaterThan(0)

    // 4. 语义检索命中
    const searchRes = await app.request(`/api/knowledge-base/${knowledgeBaseId}/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "如何创建会话", topK: 3 }),
    })
    const searchJson = await searchRes.json()
    if (searchRes.status !== 200) {
      const { pool } = await import("../src/db/index.js")
      const rows = await pool.query(`SELECT id FROM ${SCHEMA}.knowledge_bases`)
      console.log("[e2e] search 404 body:", JSON.stringify(searchJson).slice(0, 200))
      console.log("[e2e] expect id:", knowledgeBaseId, "| db rows:", JSON.stringify(rows.rows))
    }
    expect(searchRes.status).toBe(200)
    const items = searchJson.data?.results ?? []
    expect(items.length).toBeGreaterThan(0)
    expect(items[0].score).toBeGreaterThan(0)
  }, 180_000)
})
