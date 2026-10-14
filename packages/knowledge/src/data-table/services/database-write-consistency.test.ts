/**
 * 写入一致性单测：模型或向量写入失败时的副作用（补偿删除、旧向量保留、建库冲突）。
 * 只 mock 外部依赖（ai、db、pool、rag），被测逻辑保持真实。
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";

const embedMany = mock(async (_args: any) => ({ embeddings: [] as number[][] }));
mock.module("ai", () => ({
  embedMany: (args: any) => embedMany(args),
  embed: mock(),
  generateText: mock(),
  generateObject: mock(),
  streamText: mock(),
}));

mock.module("../../rag/knowledge-base/index.js", () => ({
  keywordSearchService: { createPerformanceIndexes: mock().mockResolvedValue(undefined) },
}));

let clientQuery: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> = async () => ({ rows: [] });
const queries: string[] = [];
const poolConnect = mock(async () => ({
  query: (sql: string, params?: unknown[]) => {
    queries.push(sql);
    return clientQuery(sql, params);
  },
  release: () => {},
}));
const dbSelect = mock();

mock.module("../db/index.js", () => ({
  schemaName: "test_schema",
  pool: { connect: poolConnect },
  db: { select: dbSelect },
  databaseBases: { id: { name: "id" } },
}));

const { DatabaseService } = await import("./database.service");

const doc = { chunkPlainText: async (t: string) => [{ text: t }] };

function vectorFake() {
  return {
    deleteByRowId: mock(async () => {}),
    deleteByVectorId: mock(async () => {}),
    upsertVectors: mock(async () => {}),
    pruneByRowId: mock(async () => {}),
  };
}

function registryRow(over: Record<string, unknown> = {}) {
  return {
    id: "ds1",
    name: "DS",
    description: null,
    embeddingModel: "openai/mock",
    defaultChunkStrategy: "recursive",
    defaultChunkConfig: {},
    indexName: "kb_ds1",
    indexDimension: 1536,
    indexCreated: 1,
    indexCreatedAt: null,
    dataTableName: "rd_tbl_ds1",
    columnDefinitions: [{ name: "title" }, { name: "desc" }],
    vectorStrategy: "row",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function mockRegistry(row: Record<string, unknown>) {
  dbSelect.mockReturnValue({ from: () => ({ where: () => ({ limit: async () => [row] }) }) } as never);
}

function datasetMeta() {
  return {
    indexCreated: true,
    embeddingModel: "openai/mock",
    defaultChunkStrategy: "recursive",
    defaultChunkConfig: {},
    columnDefinitions: [{ name: "title" }, { name: "desc" }],
    vectorStrategy: "row",
  };
}

beforeEach(() => {
  queries.length = 0;
  clientQuery = async () => ({ rows: [] });
});

describe("写入失败补偿", () => {
  it("行已提交但向量化失败：删除本次写入的行与向量，并抛出统一错误", async () => {
    mockRegistry(registryRow());
    const vec = vectorFake();
    const svc = new DatabaseService(vec as any, doc as any);
    embedMany.mockRejectedValueOnce(new Error("模型故障"));

    await expect(
      svc.insertRowsFromMetadataBatch("ds1", [{ title: "订单", desc: "创建" }]),
    ).rejects.toThrow("Failed to index rows: 模型故障");

    expect(queries.some((q) => q.includes("DELETE FROM test_schema.rd_tbl_ds1"))).toBe(true);
    expect(vec.deleteByRowId).toHaveBeenCalledTimes(1);
  });

  it("写入成功：不触发补偿，返回已写入的行", async () => {
    mockRegistry(registryRow());
    const vec = vectorFake();
    const svc = new DatabaseService(vec as any, doc as any);
    embedMany.mockResolvedValueOnce({ embeddings: [[0.1, 0.2]] });
    clientQuery = async (sql, params) =>
      sql.includes("ANY($1::varchar[])")
        ? { rows: (params![0] as string[]).map((id) => ({ id, title: "订单", desc: "创建" })) }
        : { rows: [] };

    const out = await svc.insertRowsFromMetadataBatch("ds1", [{ title: "订单", desc: "创建" }]);

    expect(out.count).toBe(1);
    expect(queries.some((q) => q.includes("DELETE FROM"))).toBe(false);
    expect(vec.deleteByRowId).not.toHaveBeenCalled();
  });
});

describe("重向量化：先写后清", () => {
  it("模型失败时不删除旧向量（行仍保有上一版索引）", async () => {
    const vec = vectorFake();
    const svc = new DatabaseService(vec as any, doc as any);
    embedMany.mockRejectedValueOnce(new Error("模型故障"));

    await expect(
      (svc as any).revectorizeRowsBatch("ds1", datasetMeta(), [{ id: "r1", title: "订单", desc: "创建" }]),
    ).rejects.toThrow("模型故障");

    expect(vec.deleteByRowId).not.toHaveBeenCalled();
    expect(vec.pruneByRowId).not.toHaveBeenCalled();
  });

  it("成功时先写入新向量，再按行清理不在新集合内的陈旧向量", async () => {
    const log: string[] = [];
    const vec = vectorFake();
    vec.upsertVectors = mock(async () => {
      log.push("upsert");
    });
    vec.pruneByRowId = mock(async (_ds: string, rowId: string, keep: string[]) => {
      log.push(`prune:${rowId}:${keep.join(",")}`);
    }) as any;
    const svc = new DatabaseService(vec as any, doc as any);
    embedMany.mockResolvedValueOnce({ embeddings: [[0.1, 0.2]] });

    await (svc as any).revectorizeRowsBatch("ds1", datasetMeta(), [{ id: "r1", title: "订单", desc: "创建" }]);

    expect(log).toEqual(["upsert", "prune:r1:r1__c0"]);
  });
});

describe("建库索引名冲突检查", () => {
  it("注册表已占用同一索引名或数据表名：拒绝（INDEX_NAME_CONFLICT）", async () => {
    const svc = new DatabaseService({} as any, doc as any);
    clientQuery = async (sql) =>
      sql.includes("FROM test_schema.databases WHERE index_name")
        ? { rows: [{ id: "other" }] }
        : { rows: [] };

    await expect(
      (svc as any).assertIndexNameAvailable("new", "kb_new", "rd_tbl_new"),
    ).rejects.toMatchObject({ code: "INDEX_NAME_CONFLICT" });
  });

  it("物理向量表已存在但未注册（孤儿表）：同样拒绝，避免静默复用旧向量", async () => {
    const svc = new DatabaseService({} as any, doc as any);
    clientQuery = async (sql) =>
      sql.includes("to_regclass") ? { rows: [{ reg: "test_schema.kb_new" }] } : { rows: [] };

    await expect(
      (svc as any).assertIndexNameAvailable("new", "kb_new", "rd_tbl_new"),
    ).rejects.toMatchObject({ code: "INDEX_NAME_CONFLICT" });
  });

  it("无冲突：正常通过", async () => {
    const svc = new DatabaseService({} as any, doc as any);
    clientQuery = async () => ({ rows: [] });

    await expect((svc as any).assertIndexNameAvailable("new", "kb_new", "rd_tbl_new")).resolves.toBeUndefined();
  });
});
