import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";

mock.module("../rag/knowledge-base/index.js", () => {
  const mockHybridSearchService = {
    search: mock(),
  };
  const mockKnowledgeBaseService = {
    listKnowledgeBases: mock(),
    getDocument: mock(),
  };
  return {
    hybridSearchService: mockHybridSearchService,
    knowledgeBaseService: mockKnowledgeBaseService,
  };
});

// database 依赖已改为注入（知识库包不内置 src/apis/database），这里构造注入用 mock
const runDatabaseRowsSearchMock = mock();
const databaseDeps = {
  runDatabaseRowsSearch: runDatabaseRowsSearchMock,
  databaseService: {} as unknown,
  RowsSearchRequestSchema: { parse: (data: unknown) => data },
};

mock.module("../utils/media-extractor.js", () => ({
  extractAllMedia: mock(() => ({
    images: [],
    videos: [],
  })),
}));

mock.module("../utils/rag-trace-logger.js", () => ({
  getOrCreateTraceId: mock(() => "trace-1"),
  appendRetrievalTraceId: mock(),
  logRagTrace: mock(),
}));

mock.module("../utils/create-tool.js", () => ({
  createTool: mock((config: any) => config),
}));

// 在依赖 mock 就绪后再导入被测模块
const { createRagDocumentSearchTool } = await import("./rag-document-search-tool.js");
const { hybridSearchService, knowledgeBaseService } = await import("../rag/knowledge-base/index.js");

const mockKbResult = {
  id: "kb-result-1",
  text: "文档里提到了旧称",
  score: 0.9,
  documentId: "doc1",
  chunkIndex: 0,
  metadata: {
    docName: "测试文档",
    docUrl: "https://example.com/doc",
  },
};

const mockDatabaseResponse = {
  status: 200 as const,
  body: {
    results: [
      {
        id: "vec1",
        vectorId: "vec1",
        text: "标准名称：影刀 RPA 控制台",
        score: 0.88,
        documentId: "row1",
        chunkIndex: 0,
        metadata: {
          rowId: "row1",
          title: "影刀 RPA 控制台",
          name: "internal_console_name",
        },
        row: {
          title: "影刀 RPA 控制台",
        },
      },
    ],
    total: 1,
    searchType: "hybrid" as const,
    reranked: false,
    sqlFilter: false,
    mode: "query" as const,
    vectorSearch: true,
  },
};

/** bun:test 无 vi.waitFor，使用简单轮询 */
async function waitFor(check: () => void, timeout = 200): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      check();
      return;
    } catch {
      if (Date.now() - start > timeout) throw new Error("waitFor timeout");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

function executeTool(
  tool: ReturnType<typeof createRagDocumentSearchTool>,
  context: {
    query: string;
    topK: number;
    knowledgeBaseIds?: string[];
    knowledgeBaseNames?: string[];
  },
  tracingContext?: unknown,
) {
  expect(tool.execute).toBeDefined();
  return tool.execute({
    context,
    runtimeContext: {} as any,
    tracingContext,
  } as any);
}

describe("rag-document-search-tool", () => {
  const consoleSpies: Array<ReturnType<typeof spyOn>> = [];

  beforeEach(() => {
    consoleSpies.push(
      spyOn(console, "error").mockImplementation(() => {}),
      spyOn(console, "warn").mockImplementation(() => {}),
      spyOn(console, "log").mockImplementation(() => {}),
    );
    mock.clearAllMocks();
    ;(knowledgeBaseService.listKnowledgeBases as any).mockResolvedValue({
      items: [{ id: "kb_doc", name: "kb_doc", description: "" }],
      total: 1,
    });
    ;(hybridSearchService.search as any).mockResolvedValue([mockKbResult]);
    runDatabaseRowsSearchMock.mockResolvedValue(mockDatabaseResponse);
  });

  afterEach(() => {
    for (const spy of consoleSpies) spy.mockRestore();
    consoleSpies.length = 0;
  });

  it("未配置 terminologyDatasetId/databaseDatasetId 时只执行 KB 检索", async () => {
    const tool = createRagDocumentSearchTool({
      knowledgeBaseIds: ["kb_doc"],
    });

    const result = await executeTool(tool, { query: "测试问题", topK: 5 });

    expect(hybridSearchService.search).toHaveBeenCalledTimes(1);
    expect(runDatabaseRowsSearchMock).not.toHaveBeenCalled();
    expect(result.retrievalMode).toBe("knowledge_base");
    expect(result.results).toHaveLength(1);
  });

  it("配置 terminologyDatasetId 时并行执行 KB 与 database hybrid search", async () => {
    const started: string[] = [];
    let resolveKb: ((value: any) => void) | undefined;
    let resolveDb: ((value: any) => void) | undefined;

    ;(hybridSearchService.search as any).mockImplementation(() => {
      started.push("kb");
      return new Promise((resolve) => {
        resolveKb = resolve;
      });
    });
    runDatabaseRowsSearchMock.mockImplementation(() => {
      started.push("database");
      return new Promise((resolve) => {
        resolveDb = resolve;
      });
    });

    const tool = createRagDocumentSearchTool({
      knowledgeBaseIds: ["kb_doc"],
      terminologyDatasetId: "rd_terms",
      databaseDeps,
    });

    const promise = executeTool(tool, { query: "测试问题", topK: 5 });

    await waitFor(() => {
      expect(started).toHaveLength(2);
      expect(started).toEqual(expect.arrayContaining(["kb", "database"]));
    });
    resolveKb?.([mockKbResult]);
    resolveDb?.(mockDatabaseResponse);

    const result = await promise;
    expect(runDatabaseRowsSearchMock).toHaveBeenCalledWith(
      "rd_terms",
      expect.objectContaining({
        query: "测试问题",
        topK: 200,
        limit: 200,
        selectFields: ["title"],
        searchType: "hybrid",
        recallConfig: expect.objectContaining({
          enableMultiStage: false,
        }),
      }),
      expect.any(Object),
      ["title"],
    );
    expect(result.retrievalMode).toBe("knowledge_base_with_database");
    expect("databaseResults" in result).toBe(false);
    expect("mergedEvidence" in result).toBe(false);
    expect("retrievalDebug" in result).toBe(false);
    expect(result.instructionNameCandidates).toEqual([
      {
        title: "影刀 RPA 控制台",
      },
    ]);
  });

  it("database 默认召回 200 条，并按候选上限返回指令名候选", async () => {
    runDatabaseRowsSearchMock.mockResolvedValue({
      status: 200,
      body: {
        results: Array.from({ length: 60 }, (_, index) => ({
          id: `vec${index}`,
          vectorId: `vec${index}`,
          text: `指令${index}`,
          score: 1 - index / 100,
          documentId: `row${index}`,
          chunkIndex: 0,
          metadata: {
            rowId: `row${index}`,
            title: `指令${index}`,
          },
          row: {
            title: `指令${index}`,
          },
        })),
        total: 60,
        searchType: "hybrid",
        mode: "query",
      },
    });

    const tool = createRagDocumentSearchTool({
      knowledgeBaseIds: ["kb_doc"],
      databaseDatasetId: "rd_terms",
      databaseDeps,
    });

    const result = await executeTool(tool, { query: "测试问题", topK: 5 });

    expect(runDatabaseRowsSearchMock).toHaveBeenCalledWith(
      "rd_terms",
      expect.objectContaining({
        topK: 200,
        limit: 200,
        selectFields: ["title"],
      }),
      expect.any(Object),
      ["title"],
    );
    expect(result.instructionNameCandidates).toHaveLength(60);
    expect("databaseResults" in result).toBe(false);
    expect(result.instructionNameCandidates?.[0]).toEqual({
      title: "指令0",
    });
    expect(
      result.instructionNameCandidates?.some(
        (candidate: { title: string }) => candidate.title === "指令59",
      ),
    ).toBe(true);
  });

  it("不再返回 terminologyConstraints", async () => {
    const tool = createRagDocumentSearchTool({
      knowledgeBaseIds: ["kb_doc"],
      databaseDatasetId: "rd_terms",
      databaseDeps,
    });

    const result = await executeTool(tool, { query: "控制台怎么用", topK: 10 });

    expect("terminologyConstraints" in result).toBe(false);
    expect("databaseResults" in result).toBe(false);
    expect("mergedEvidence" in result).toBe(false);
    expect("retrievalDebug" in result).toBe(false);
  });

  it("在工具 Span 下只创建知识库和数据库两个一级检索 Span", async () => {
    const spans = new Map(
      ["retrieval.knowledge_base", "retrieval.database"].map((name) => [
        name,
        { end: mock(), error: mock() },
      ]),
    );
    const createChildSpan = mock(({ name }: { name: string }) =>
      spans.get(name),
    );
    const tool = createRagDocumentSearchTool({
      knowledgeBaseIds: ["kb_doc"],
      terminologyDatasetId: "rd_terms",
      databaseDeps,
    });

    await executeTool(
      tool,
      { query: "测试问题", topK: 5 },
      { currentSpan: { createChildSpan } },
    );

    expect(createChildSpan).toHaveBeenCalledTimes(2);
    expect(createChildSpan.mock.calls.map((call: any[]) => call[0].name)).toEqual([
      "retrieval.knowledge_base",
      "retrieval.database",
    ]);
    expect(spans.get("retrieval.knowledge_base")?.end).toHaveBeenCalledTimes(1);
    expect(spans.get("retrieval.database")?.end).toHaveBeenCalledTimes(1);
    expect(spans.get("retrieval.knowledge_base")?.end).toHaveBeenCalledWith(
      expect.objectContaining({
        output: expect.objectContaining({
          results: [
            expect.objectContaining({
              text: mockKbResult.text,
              score: mockKbResult.score,
              documentId: mockKbResult.documentId,
              chunkIndex: mockKbResult.chunkIndex,
            }),
          ],
          total: 1,
          retrievalDebug: expect.objectContaining({
            stages: expect.any(Array),
          }),
        }),
      }),
    );
  });
});
