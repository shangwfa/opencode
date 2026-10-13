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
      undefined,
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
