import { describe, expect, mock, test } from "bun:test"
import { RowsSearchRequestSchema } from "../src/data-table/types/database.types"

const vector = mock(async (..._args: any[]) => [] as any[])
const keyword = mock(async (..._args: any[]) => [] as any[])
const hybrid = mock(async (..._args: any[]) => [] as any[])
const recall = mock(async (..._args: any[]) => [] as any[])
const embeddingBatch = mock(async (..._args: any[]) => ({ embeddings: [] as number[][] }))
const queries: string[] = []
mock.module("../src/data-table/db/index.js", () => ({
  schemaName: "audit_schema", db: {}, databaseBases: {},
  pool: { connect: async () => ({ query: async (sql: string) => { queries.push(sql); return { rows: [] } }, release: mock() }) },
}))
mock.module("../src/rag/knowledge-base/index.js", () => ({
  vectorService: { primeIndexNameCache: mock(), query: vector },
  keywordSearchService: { primeIndexNameCache: mock(), search: keyword },
  hybridSearchService: { search: hybrid },
  recallService: { recall },
  rerankService: { rerank: mock(async (_: string, hits: any[]) => hits) },
  getHyDEService: mock(), getMultiQueryService: mock(),
}))
mock.module("ai", () => ({
  embed: mock(async () => ({ embedding: [1, 0, 0] })),
  embedMany: embeddingBatch,
  generateText: mock(), generateObject: mock(), streamText: mock(),
}))
mock.module("../src/providers/llm.js", () => ({ openaiEmbedding: mock(() => ({})) }))
const { runDatabaseRowsSearch } = await import("../src/data-table/services/database-rows-search")
const { DatabaseService } = await import("../src/data-table/services/database.service")
const { getKnowledgeBaseIndexName } = await import("../src/utils/index-name")
const hit = (id: string, rowId: string) => ({ id, score: 0.9, text: "订单", metadata: { rowId, secret: "内部字段" } })
const service: any = {
  getDatabase: mock(async () => ({ id: "audit", embeddingModel: "mock", indexName: "kb_audit" })),
  searchRowsByFilter: mock(async () => [{ id: "allowed" }]),
  hydrateSearchResults: mock(async (_: string, hits: any[]) => hits.map(h => ({ ...h, documentId: h.metadata.rowId, row: { id: h.metadata.rowId, name: "订单", secret: "内部字段" } }))),
}
process.env.DB_ROWS_SEARCH_PROFILE = "false"
describe("审计回归与未修复探针：不代表完整目标验收通过", () => {
  test("回归：默认 hybrid 执行 hybrid 分支", async () => {
    mock.clearAllMocks()
    const out = await runDatabaseRowsSearch("audit", RowsSearchRequestSchema.parse({ query: "订单", searchType: "hybrid", topK: 3 }), service)
    expect(out.status).toBe(200)
    expect(recall).not.toHaveBeenCalled()
    expect(hybrid).toHaveBeenCalled()
  })
  test("回归：keyword + queryExpansion 显式拒绝，不改走语义分支", async () => {
    mock.clearAllMocks()
    const out = await runDatabaseRowsSearch("audit", RowsSearchRequestSchema.parse({ query: "订单", searchType: "keyword", recallConfig: { enableQueryExpansion: true } }), service)
    expect(out.status).toBe(400)
    expect(recall).not.toHaveBeenCalled()
    expect(keyword).not.toHaveBeenCalled()
  })
  test("回归：权重 0 保留", async () => {
    mock.clearAllMocks()
    await runDatabaseRowsSearch("audit", RowsSearchRequestSchema.parse({ query: "订单", searchType: "hybrid", hybridWeight: { semantic: 0, keyword: 1 }, recallConfig: { enableMultiStage: false } }), service)
    expect(hybrid.mock.calls[0]?.[2]?.semanticWeight).toBe(0)
  })
  test("投影仅裁剪 row，metadata 仍返回全部字段", async () => {
    vector.mockResolvedValue([hit("allowed__c0", "allowed")])
    const out: any = await runDatabaseRowsSearch("audit", RowsSearchRequestSchema.parse({ query: "订单", topK: 3, selectFields: ["name"], rerankConfig: { enableRerank: false } }), service)
    expect(out.body.results[0].row).toEqual({ name: "订单" })
    expect(out.body.results[0].metadata.secret).toBe("内部字段")
  })
  test("一行多个 chunk 消耗 topK，没有行级聚合", async () => {
    vector.mockResolvedValue([hit("allowed__c0", "allowed"), hit("allowed__c1", "allowed")])
    const out: any = await runDatabaseRowsSearch("audit", RowsSearchRequestSchema.parse({ query: "订单", topK: 2, rerankConfig: { enableRerank: false } }), service)
    expect(out.body.results).toHaveLength(2)
    expect(new Set(out.body.results.map((r: any) => r.documentId)).size).toBe(1)
  })
  test("组合检索未下推 allowedIds，全库 topK 外的候选漏召回", async () => {
    vector.mockResolvedValue([hit("outside__c0", "outside")])
    const out: any = await runDatabaseRowsSearch("audit", RowsSearchRequestSchema.parse({ query: "订单", topK: 2, filter: { region: "华东" }, rerankConfig: { enableRerank: false } }), service)
    expect(out.body.results).toHaveLength(0)
    expect(vector.mock.calls.at(-1)?.[3]).toBeUndefined()
  })
  test("不同领域和不同原始 id 可映射同一向量表", () => {
    expect(getKnowledgeBaseIndexName("orders")).toBe(getKnowledgeBaseIndexName("kb_orders"))
    expect(getKnowledgeBaseIndexName("A-B")).toBe(getKnowledgeBaseIndexName("a_b"))
  })
  test("行已 COMMIT 后 embedding 失败，API 抛错但事务未回滚", async () => {
    queries.length = 0
    embeddingBatch.mockRejectedValue(new Error("审计注入 embedding 故障"))
    const dbs = new DatabaseService({} as any, { chunkPlainText: async () => [{ text: "订单" }] } as any)
    dbs.getDatabase = mock(async () => ({ id: "audit", dataTableName: "rd_tbl_audit", indexCreated: true, embeddingModel: "openai/mock", columnDefinitions: [{ name: "title" }] })) as any
    await expect(dbs.insertRowsFromMetadataBatch("audit", [{ title: "订单" }])).rejects.toThrow("审计注入")
    expect(queries).toContain("COMMIT")
    expect(queries).not.toContain("ROLLBACK")
  })
  test("回归：重向量化在 embedding 失败时保留旧向量（已修复，原探针刻画先删后算）", async () => {
    const deleteByRowId = mock(async () => {})
    const pruneByRowId = mock(async () => {})
    embeddingBatch.mockRejectedValue(new Error("审计注入 embedding 故障"))
    const dbs = new DatabaseService({ deleteByRowId, pruneByRowId, deleteByVectorId: mock(async () => {}) } as any, { chunkPlainText: async () => [{ text: "新订单" }] } as any)
    await expect((dbs as any).revectorizeRowsBatch("audit", { indexCreated: true, embeddingModel: "openai/mock", columnDefinitions: [{ name: "title" }] }, [{ id: "row", title: "新订单" }])).rejects.toThrow("审计注入")
    expect(deleteByRowId).not.toHaveBeenCalled()
    expect(pruneByRowId).not.toHaveBeenCalled()
  })
})
