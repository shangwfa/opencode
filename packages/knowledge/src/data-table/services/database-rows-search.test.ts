/**
 * database-rows-search 单元测试：隔离向量 / 召回 / 重排等外部依赖，只验证编排逻辑。
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  RowsSearchRequestSchema,
  type RowsSearchRequest,
} from "../types/database.types.js";
import type { DatabaseService } from "./database.service.js";
import { SEARCH_ERROR_MESSAGES } from "../../config/search.constants.js";

const vectorQuery = mock();
const keywordSearch = mock();
const hybridSearch = mock();
const recall = mock();
const rerank = mock();
const primeVector = mock();
const primeKeyword = mock();

mock.module("../../rag/knowledge-base/index.js", () => ({
  vectorService: {
    primeIndexNameCache: primeVector,
    query: vectorQuery,
  },
  keywordSearchService: {
    primeIndexNameCache: primeKeyword,
    search: keywordSearch,
  },
  hybridSearchService: {
    search: hybridSearch,
  },
  recallService: {
    recall: recall,
  },
  rerankService: {
    rerank: rerank,
  },
  getHyDEService: mock(),
  getMultiQueryService: mock(),
}));

// mock 'ai' 必须提供全量导出，否则同进程其它文件 import 链接失败
mock.module("ai", () => ({
  embed: mock().mockResolvedValue({
    embedding: [0.1, 0.2, 0.3],
  }),
  embedMany: mock().mockResolvedValue({ embeddings: [] }),
  generateText: mock().mockResolvedValue({ text: "" }),
  generateObject: mock().mockResolvedValue({ object: {} }),
  streamText: mock().mockResolvedValue({}),
}));

mock.module("../../providers/llm.js", () => ({
  openaiEmbedding: mock(() => ({})),
  openaiChat: mock(() => ({})),
  createEmbeddingModel: mock(() => ({})),
  createChatModel: mock(() => ({})),
  resetLLMProviderCache: mock(),
}));

function baseDataset() {
  return {
    id: "ds1",
    name: "Test DS",
    embeddingModel: "openai/text-embedding-3-small",
    defaultChunkStrategy: "recursive" as const,
    dataTableName: "tbl_test",
    columnDefinitions: [{ name: "col_a" }],
    vectorStrategy: "row",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("runDatabaseRowsSearch", () => {
  let runDatabaseRowsSearch: typeof import("./database-rows-search.js").runDatabaseRowsSearch;

  beforeEach(async () => {
    // 不要用 resetAllMocks：会清空 mock.module('ai') 里 embed 的 mockResolvedValue
    mock.clearAllMocks();
    process.env.DB_ROWS_SEARCH_PROFILE = "false";
    vectorQuery.mockResolvedValue([
      {
        id: "row_a__c0",
        score: 0.95,
        metadata: { text: "chunk a", rowId: "row_a", chunkIndex: 0 },
      },
      {
        id: "row_b__c0",
        score: 0.5,
        metadata: { text: "chunk b", rowId: "row_b", chunkIndex: 0 },
      },
    ]);
    keywordSearch.mockResolvedValue([]);
    hybridSearch.mockResolvedValue([]);
    recall.mockResolvedValue([]);
    rerank.mockImplementation(async (_q: string, results: unknown[]) =>
      Promise.resolve(results as never[]),
    );
    const mod = await import("./database-rows-search.js");
    runDatabaseRowsSearch = mod.runDatabaseRowsSearch;
  });

  afterEach(() => {
    delete process.env.DB_ROWS_SEARCH_PROFILE;
  });

  it("数据集不存在时返回 404", async () => {
    const databaseService = {
      getDatabase: mock().mockResolvedValue(null),
      searchRowsByFilter: mock(),
      hydrateSearchResults: mock(),
    } as unknown as DatabaseService;

    const out = await runDatabaseRowsSearch(
      "missing",
      { query: "q", topK: 10 } as RowsSearchRequest,
      databaseService,
    );

    expect(out.status).toBe(404);
    expect((out.body as { message: string }).message).toBe("Dataset not found");
    expect(vectorQuery).not.toHaveBeenCalled();
  });

  it("仅 filter 时走 SQL 列表，不触发向量检索", async () => {
    const databaseService = {
      getDatabase: mock().mockResolvedValue(baseDataset()),
      searchRowsByFilter: mock().mockResolvedValue([{ id: "r1", col_a: "x" }]),
      hydrateSearchResults: mock(),
    } as unknown as DatabaseService;

    const out = await runDatabaseRowsSearch(
      "ds1",
      {
        filter: { col_a: "x" },
        limit: 50,
      } as unknown as RowsSearchRequest,
      databaseService,
    );

    expect(out.status).toBe(200);
    const body = out.body as import("./database-rows-search.js").DatabaseRowsSearchResponseBody;
    expect(body.mode).toBe("filter");
    expect(body.vectorSearch).toBe(false);
    expect(body.results).toHaveLength(1);
    expect(body.results[0].row).toEqual({ id: "r1", col_a: "x" });
    expect(databaseService.searchRowsByFilter).toHaveBeenCalledWith(
      "ds1",
      { col_a: "x" },
      50,
    );
    expect(vectorQuery).not.toHaveBeenCalled();
  });

  it("仅 filter 时可按 selectFields 裁剪返回 row 字段", async () => {
    const databaseService = {
      getDatabase: mock().mockResolvedValue(baseDataset()),
      searchRowsByFilter: mock().mockResolvedValue([
        {
          id: "r1",
          title: "标题",
          description: "描述",
          internal_notes: "隐藏",
        },
      ]),
      hydrateSearchResults: mock(),
    } as unknown as DatabaseService;

    const out = await runDatabaseRowsSearch(
      "ds1",
      RowsSearchRequestSchema.parse({
        filter: { title: "标题" },
        limit: 50,
        selectFields: ["title", "description"],
      }),
      databaseService,
    );

    expect(out.status).toBe(200);
    const body = out.body as import("./database-rows-search.js").DatabaseRowsSearchResponseBody;
    expect(body.results[0].row).toEqual({
      title: "标题",
      description: "描述",
    });
  });

  it("multi-stage 开启且 searchType 非 semantic 时返回 400", async () => {
    const databaseService = {
      getDatabase: mock().mockResolvedValue(baseDataset()),
      searchRowsByFilter: mock(),
      hydrateSearchResults: mock(),
    } as unknown as DatabaseService;

    const out = await runDatabaseRowsSearch(
      "ds1",
      {
        query: "hello",
        topK: 10,
        searchType: "keyword",
        recallConfig: { enableMultiStage: true },
      } as RowsSearchRequest,
      databaseService,
    );

    expect(out.status).toBe(400);
    expect((out.body as { message: string }).message).toBe(
      SEARCH_ERROR_MESSAGES.MULTI_STAGE_SEMANTIC_ONLY,
    );
    expect(keywordSearch).not.toHaveBeenCalled();
  });

  it("keyword 未指定 recallConfig 时默认关闭多阶段，正常返回 200", async () => {
    const databaseService = {
      getDatabase: mock().mockResolvedValue(baseDataset()),
      searchRowsByFilter: mock(),
      hydrateSearchResults: mock().mockResolvedValue([]),
    } as unknown as DatabaseService;

    const out = await runDatabaseRowsSearch(
      "ds1",
      RowsSearchRequestSchema.parse({ query: "库存盘点", searchType: "keyword" }),
      databaseService,
    );

    expect(out.status).toBe(200);
    expect(recall).not.toHaveBeenCalled();
    expect(keywordSearch).toHaveBeenCalled();
  });

  it("recallConfig 未显式给出 enableMultiStage 时保持 undefined（不被 schema 默认成 true）", () => {
    const parsed = RowsSearchRequestSchema.parse({
      query: "库存盘点",
      searchType: "keyword",
      recallConfig: { enableQueryExpansion: false },
    });

    expect(parsed.recallConfig?.enableMultiStage).toBeUndefined();
  });

  for (const fusionMethod of ["weighted", "rrf", "weighted-rrf", "hybrid"] as const) {
    it(`默认 hybrid 实际执行混合分支并透传 ${fusionMethod}`, async () => {
      const service = {
        getDatabase: mock().mockResolvedValue(baseDataset()),
        hydrateSearchResults: mock().mockResolvedValue([]),
      } as unknown as DatabaseService;
      const out = await runDatabaseRowsSearch("ds1", RowsSearchRequestSchema.parse({
        query: "库存", searchType: "hybrid", topK: 3, fusionMethod,
      }), service);
      expect(out.status).toBe(200);
      expect(hybridSearch).toHaveBeenCalledTimes(1);
      expect(hybridSearch.mock.calls[0][2].fusionMethod).toBe(fusionMethod);
      expect(recall).not.toHaveBeenCalled();
      expect((out.body as any).execution.strategy).toBe("hybrid");
    });
  }

  for (const hybridWeight of [{ semantic: 0, keyword: 1 }, { semantic: 1, keyword: 0 }]) {
    it(`混合检索保留零权重 ${JSON.stringify(hybridWeight)}`, async () => {
      const service = {
        getDatabase: mock().mockResolvedValue(baseDataset()),
        hydrateSearchResults: mock().mockResolvedValue([]),
      } as unknown as DatabaseService;
      const out = await runDatabaseRowsSearch("ds1", RowsSearchRequestSchema.parse({
        query: "库存", searchType: "hybrid", fusionMethod: "weighted", hybridWeight,
      }), service);
      expect(out.status).toBe(200);
      expect(hybridSearch.mock.calls[0][2].semanticWeight).toBe(hybridWeight.semantic);
      expect(hybridSearch.mock.calls[0][2].keywordWeight).toBe(hybridWeight.keyword);
    });
  }

  for (const searchType of ["keyword", "hybrid"] as const) {
    for (const options of [
      { recallConfig: { enableMultiStage: true } },
      { recallConfig: { enableQueryExpansion: true } },
      { hydeConfig: { enableHyDE: true } },
      { multiQueryConfig: { enableMultiQuery: true } },
    ]) {
      it(`${searchType} 未支持的增强组合显式拒绝 ${JSON.stringify(options)}`, async () => {
        const service = { getDatabase: mock().mockResolvedValue(baseDataset()) } as unknown as DatabaseService;
        const out = await runDatabaseRowsSearch("ds1", RowsSearchRequestSchema.parse({
          query: "库存", searchType, ...options,
        }), service);
        expect(out.status).toBe(400);
        expect(recall).not.toHaveBeenCalled();
        expect(keywordSearch).not.toHaveBeenCalled();
        expect(hybridSearch).not.toHaveBeenCalled();
      });
    }
  }

  it("混合检索全零权重在召回前拒绝", async () => {
    const service = { getDatabase: mock().mockResolvedValue(baseDataset()) } as unknown as DatabaseService;
    const out = await runDatabaseRowsSearch("ds1", RowsSearchRequestSchema.parse({
      query: "库存", searchType: "hybrid", hybridWeight: { semantic: 0, keyword: 0 },
    }), service);
    expect(out.status).toBe(400);
    expect(hybridSearch).not.toHaveBeenCalled();
  });

  for (const keywordCount of [0, 1]) {
    it(`混合执行信息记录两路结果与单路空态 keyword=${keywordCount}`, async () => {
      hybridSearch.mockImplementation(async (_id, _query, options) => {
        options.debugCollector({ stage: "semantic", results: [{ id: "s1" }] });
        options.debugCollector({ stage: "keyword", results: keywordCount ? [{ id: "k1" }] : [] });
        return [];
      });
      const service = {
        getDatabase: mock().mockResolvedValue(baseDataset()),
        hydrateSearchResults: mock().mockResolvedValue([]),
      } as unknown as DatabaseService;
      const out = await runDatabaseRowsSearch("ds1", RowsSearchRequestSchema.parse({
        query: "库存", searchType: "hybrid",
      }), service);
      expect(out.status).toBe(200);
      expect((out.body as any).execution).toMatchObject({
        strategy: "hybrid", fusionMethod: "rrf",
        branchResults: { semantic: 1, keyword: keywordCount },
        fusionApplied: keywordCount > 0,
      });
    });
  }

  it("semantic 默认过滤零相关行（空结果契约）", async () => {
    vectorQuery.mockResolvedValue([
      { id: "r1__c0", score: 0.9, metadata: { rowId: "r1", text: "命中" } },
      { id: "r2__c0", score: 0, metadata: { rowId: "r2", text: "无关" } },
    ]);
    const databaseService = {
      getDatabase: mock().mockResolvedValue(baseDataset()),
      searchRowsByFilter: mock(),
      hydrateSearchResults: mock().mockImplementation(async (_id, items) =>
        (items as { id: string; metadata?: { rowId?: string } }[]).map((r) => ({
          ...r,
          documentId: String(r.metadata?.rowId ?? r.id),
          row: { id: String(r.metadata?.rowId ?? r.id) },
        })),
      ),
    } as unknown as DatabaseService;

    const out = await runDatabaseRowsSearch(
      "ds1",
      RowsSearchRequestSchema.parse({ query: "命中", topK: 10, rerankConfig: { enableRerank: false } }),
      databaseService,
    );

    expect(out.status).toBe(200);
    const body = out.body as import("./database-rows-search.js").DatabaseRowsSearchResponseBody;
    expect(body.results.map((r) => r.id)).toEqual(["r1__c0"]);
  });

  it("semantic 透传显式 minScore 到向量查询", async () => {
    vectorQuery.mockResolvedValue([]);
    const databaseService = {
      getDatabase: mock().mockResolvedValue(baseDataset()),
      searchRowsByFilter: mock(),
      hydrateSearchResults: mock().mockResolvedValue([]),
    } as unknown as DatabaseService;

    await runDatabaseRowsSearch(
      "ds1",
      RowsSearchRequestSchema.parse({ query: "命中", topK: 5, minScore: 0.4 }),
      databaseService,
    );

    expect(vectorQuery.mock.calls[0][4]).toMatchObject({ minScore: 0.4 });
  });

  it("searchFields 非法字段名被 schema 拒绝", () => {
    expect(() =>
      RowsSearchRequestSchema.parse({ query: "命中", searchFields: ["1abc"] }),
    ).toThrow();
  });

  it("row 策略不支持 searchFields，显式拒绝", async () => {
    const databaseService = { getDatabase: mock().mockResolvedValue(baseDataset()) } as unknown as DatabaseService;
    const out = await runDatabaseRowsSearch(
      "ds1",
      RowsSearchRequestSchema.parse({ query: "命中", searchFields: ["col_a"] }),
      databaseService,
    );
    expect(out.status).toBe(400);
    expect((out.body as { message: string }).message).toContain("field");
  });

  it("field 策略 searchFields 下推为向量 metadata 过滤", async () => {
    vectorQuery.mockResolvedValue([]);
    const databaseService = {
      getDatabase: mock().mockResolvedValue({ ...baseDataset(), vectorStrategy: "field", columnDefinitions: [{ name: "col_a" }, { name: "col_b" }] }),
      searchRowsByFilter: mock(),
      hydrateSearchResults: mock().mockResolvedValue([]),
    } as unknown as DatabaseService;

    const out = await runDatabaseRowsSearch(
      "ds1",
      RowsSearchRequestSchema.parse({ query: "命中", searchFields: ["col_a", "col_b"], rerankConfig: { enableRerank: false }, recallConfig: { enableMultiStage: false } }),
      databaseService,
    );
    expect(out.status).toBe(200);
    expect(vectorQuery.mock.calls[0][3]).toEqual({ field: { $in: ["col_a", "col_b"] } });
    expect((out.body as any).execution.searchFields).toEqual(["col_a", "col_b"]);
  });

  it("field 策略默认多阶段时 searchFields 透传 recallService 过滤", async () => {
    recall.mockResolvedValue([]);
    const databaseService = {
      getDatabase: mock().mockResolvedValue({ ...baseDataset(), vectorStrategy: "field" }),
      searchRowsByFilter: mock(),
      hydrateSearchResults: mock().mockResolvedValue([]),
    } as unknown as DatabaseService;

    await runDatabaseRowsSearch(
      "ds1",
      RowsSearchRequestSchema.parse({ query: "命中", searchFields: ["col_a"] }),
      databaseService,
    );
    expect(recall.mock.calls[0][2].filter).toEqual({ field: { $in: ["col_a"] } });
  });

  it("plain semantic + 小 topK 走单阶段向量召回，不调用 recallService.recall", async () => {
    const databaseService = {
      getDatabase: mock().mockResolvedValue(baseDataset()),
      searchRowsByFilter: mock(),
      hydrateSearchResults: mock().mockImplementation(async (_id, items) =>
        (items as { id: string; metadata?: { rowId?: string } }[]).map((r) => ({
          ...r,
          documentId: String(r.metadata?.rowId ?? r.id),
          row: { id: String(r.metadata?.rowId ?? r.id) },
        })),
      ),
    } as unknown as DatabaseService;

    const out = await runDatabaseRowsSearch(
      "ds1",
      {
        query: "hello world",
        topK: 10,
        searchType: "semantic",
        rerankConfig: { enableRerank: false },
      } as RowsSearchRequest,
      databaseService,
    );

    expect(out.status).toBe(200);
    const body = out.body as import("./database-rows-search.js").DatabaseRowsSearchResponseBody;
    expect(body.mode).toBe("query");
    expect(body.recallStage).toBeUndefined();
    expect(recall).not.toHaveBeenCalled();
    expect(vectorQuery).toHaveBeenCalledTimes(1);
    expect(vectorQuery).toHaveBeenCalledWith(
      "ds1",
      [0.1, 0.2, 0.3],
      10,
      undefined,
      { minScore: 0 },
    );
    expect(body.results.length).toBeLessThanOrEqual(10);
  });

  it("query 检索 hydrate 后可按 selectFields 裁剪返回 row 字段", async () => {
    const databaseService = {
      getDatabase: mock().mockResolvedValue(baseDataset()),
      searchRowsByFilter: mock(),
      hydrateSearchResults: mock().mockImplementation(async (_id, items) =>
        (items as { id: string; metadata?: { rowId?: string } }[]).map((r) => ({
          ...r,
          documentId: String(r.metadata?.rowId ?? r.id),
          row: {
            id: String(r.metadata?.rowId ?? r.id),
            title: "标题",
            description: "描述",
            internal_notes: "隐藏",
          },
        })),
      ),
    } as unknown as DatabaseService;

    const out = await runDatabaseRowsSearch(
      "ds1",
      RowsSearchRequestSchema.parse({
        query: "hello world",
        topK: 1,
        searchType: "semantic",
        rerankConfig: { enableRerank: false },
        selectFields: ["title", "description"],
      }),
      databaseService,
    );

    expect(out.status).toBe(200);
    const body = out.body as import("./database-rows-search.js").DatabaseRowsSearchResponseBody;
    expect(body.results).toHaveLength(1);
    expect(body.results[0].row).toEqual({
      title: "标题",
      description: "描述",
    });
  });

  it("combined：SQL 预过滤无 id 时返回空结果", async () => {
    const databaseService = {
      getDatabase: mock().mockResolvedValue(baseDataset()),
      searchRowsByFilter: mock().mockResolvedValue([]),
      hydrateSearchResults: mock(),
    } as unknown as DatabaseService;

    const out = await runDatabaseRowsSearch(
      "ds1",
      {
        query: "q",
        filter: { col_a: "nomatch" },
        topK: 10,
        limit: 100,
        searchType: "semantic",
        rerankConfig: { enableRerank: false },
      } as unknown as RowsSearchRequest,
      databaseService,
    );

    expect(out.status).toBe(200);
    const body = out.body as import("./database-rows-search.js").DatabaseRowsSearchResponseBody;
    expect(body.results).toHaveLength(0);
    expect(body.mode).toBe("combined");
    expect(databaseService.searchRowsByFilter).toHaveBeenCalledWith(
      "ds1",
      { col_a: "nomatch" },
      100,
      { idOnly: true },
    );
    expect(vectorQuery).not.toHaveBeenCalled();
  });

  it("combined：向量命中按 allowedIds 交集过滤", async () => {
    vectorQuery.mockResolvedValue([
      {
        id: "row_in__c0",
        score: 0.99,
        metadata: { text: "in", rowId: "row_in", chunkIndex: 0 },
      },
      {
        id: "row_out__c0",
        score: 0.98,
        metadata: { text: "out", rowId: "row_out", chunkIndex: 0 },
      },
    ]);
    const databaseService = {
      getDatabase: mock().mockResolvedValue(baseDataset()),
      searchRowsByFilter: mock()
        .mockResolvedValue([{ id: "row_in" }, { id: "row_other" }]),
      hydrateSearchResults: mock().mockImplementation(async (_id, items) =>
        (items as { id: string; metadata?: { rowId?: string } }[]).map((r) => ({
          ...r,
          documentId: String(r.metadata?.rowId ?? r.id),
          row: { id: String(r.metadata?.rowId ?? r.id) },
        })),
      ),
    } as unknown as DatabaseService;

    const out = await runDatabaseRowsSearch(
      "ds1",
      {
        query: "q",
        filter: { col_a: "x" },
        topK: 10,
        limit: 100,
        searchType: "semantic",
        rerankConfig: { enableRerank: false },
      } as unknown as RowsSearchRequest,
      databaseService,
    );

    expect(out.status).toBe(200);
    const body = out.body as import("./database-rows-search.js").DatabaseRowsSearchResponseBody;
    expect(body.mode).toBe("combined");
    expect(recall).not.toHaveBeenCalled();
    expect(vectorQuery).toHaveBeenCalledTimes(1);
    expect(body.results).toHaveLength(1);
    expect(body.results[0].metadata?.rowId ?? body.results[0].row?.id).toBe("row_in");
  });
});
