/**
 * 幂等写入（keyColumn）单测：批内校验、upsert 语义、补偿只删新插入行、建库 schema 校验。
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";
import { CreateDatabaseRequestSchema, UpdateDatabaseRequestSchema } from "../types/database.types";

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
const queries: Array<{ sql: string; params?: unknown[] }> = [];
const poolConnect = mock(async () => ({
  query: (sql: string, params?: unknown[]) => {
    queries.push({ sql, params });
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
    deleteByRowId: mock(async (_ds: string, _rowId: string) => {}),
    deleteByVectorId: mock(async () => {}),
    upsertVectors: mock(async () => {}),
    pruneByRowId: mock(async (_ds: string, _rowId: string, _keep: string[]) => {}),
  };
}

function keyedRow() {
  return {
    id: "ds1",
    name: "订单",
    description: null,
    embeddingModel: "openai/mock",
    defaultChunkStrategy: "recursive",
    defaultChunkConfig: {},
    indexName: "kb_ds1",
    indexDimension: 1536,
    indexCreated: 1,
    indexCreatedAt: null,
    dataTableName: "rd_tbl_ds1",
    columnDefinitions: [{ name: "orderNo" }, { name: "title" }],
    vectorStrategy: "row",
    keyColumn: "orderNo",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function mockRegistry(row: Record<string, unknown>) {
  dbSelect.mockReturnValue({ from: () => ({ where: () => ({ limit: async () => [row] }) }) } as never);
}

beforeEach(() => {
  queries.length = 0;
  clientQuery = async () => ({ rows: [] });
});

describe("幂等写入：批内校验", () => {
  it("批内重复 key 直接拒绝，且不发起任何写入", async () => {
    mockRegistry(keyedRow());
    const svc = new DatabaseService(vectorFake() as any, doc as any);

    await expect(
      svc.insertRowsFromMetadataBatch("ds1", [
        { orderNo: "A1", title: "a" },
        { orderNo: "A1", title: "b" },
      ]),
    ).rejects.toThrow('Duplicate key "A1" in rows[0] and rows[1]');
    expect(queries.some((q) => q.sql.includes("INSERT INTO"))).toBe(false);
  });

  it("缺失 key 列直接拒绝，并指出行号", async () => {
    mockRegistry(keyedRow());
    const svc = new DatabaseService(vectorFake() as any, doc as any);

    await expect(
      svc.insertRowsFromMetadataBatch("ds1", [{ orderNo: "A1", title: "a" }, { title: "无 key" }]),
    ).rejects.toThrow('Missing key column "orderNo" in rows[1]');
    expect(queries.some((q) => q.sql.includes("INSERT INTO"))).toBe(false);
  });
});

describe("幂等写入：upsert 语义", () => {
  it("使用 ON CONFLICT 按 key 覆盖；仅被覆盖的行清理陈旧向量", async () => {
    mockRegistry(keyedRow());
    const vec = vectorFake();
    const svc = new DatabaseService(vec as any, doc as any);
    clientQuery = async (sql, params) => {
      if (sql.includes("ON CONFLICT")) {
        return {
          rows: [
            { id: "r_new", k: "A1", inserted: true },
            { id: "r_old", k: "B2", inserted: false },
          ],
        };
      }
      if (sql.includes("ANY($1::varchar[])")) {
        return {
          rows: (params![0] as string[]).map((id) => ({ id, orderNo: id === "r_new" ? "A1" : "B2", title: "t" })),
        };
      }
      return { rows: [] };
    };
    embedMany.mockResolvedValueOnce({ embeddings: [[0.1], [0.2]] });

    const out = await svc.insertRowsFromMetadataBatch("ds1", [
      { orderNo: "A1", title: "新" },
      { orderNo: "B2", title: "更新" },
    ]);

    const upsert = queries.find((q) => q.sql.includes("ON CONFLICT"))!;
    expect(upsert.sql).toContain('ON CONFLICT ("orderNo") DO UPDATE SET "title" = EXCLUDED."title"');
    expect(out.count).toBe(2);
    expect(vec.pruneByRowId).toHaveBeenCalledTimes(1);
    expect(vec.pruneByRowId.mock.calls[0]).toEqual(["ds1", "r_old", ["r_old__c0"]]);
  });

  it("向量失败：只删除本次新插入的行与向量，被覆盖的行保留", async () => {
    mockRegistry(keyedRow());
    const vec = vectorFake();
    const svc = new DatabaseService(vec as any, doc as any);
    clientQuery = async (sql) =>
      sql.includes("ON CONFLICT")
        ? {
            rows: [
              { id: "r_new", k: "A1", inserted: true },
              { id: "r_old", k: "B2", inserted: false },
            ],
          }
        : { rows: [] };
    embedMany.mockRejectedValueOnce(new Error("模型故障"));

    await expect(
      svc.insertRowsFromMetadataBatch("ds1", [
        { orderNo: "A1", title: "新" },
        { orderNo: "B2", title: "更新" },
      ]),
    ).rejects.toThrow("Failed to index rows: 模型故障");

    const compensation = queries.find((q) => q.sql.includes("DELETE FROM test_schema.rd_tbl_ds1"));
    expect(compensation?.params).toEqual([["r_new"]]);
    expect(vec.deleteByRowId.mock.calls.map((c) => c[1])).toEqual(["r_new"]);
    expect(vec.pruneByRowId).not.toHaveBeenCalled();
  });
});

describe("建库 keyColumn 校验", () => {
  const base = {
    name: "订单",
    columns: [{ name: "orderNo" }, { name: "title" }],
  };

  it("keyColumn 必须是已声明的列", () => {
    expect(() => CreateDatabaseRequestSchema.parse({ ...base, keyColumn: "ghost" })).toThrow();
  });

  it("keyColumn 为已声明列时通过，且默认值保持不变", () => {
    const parsed = CreateDatabaseRequestSchema.parse({ ...base, keyColumn: "orderNo" });
    expect(parsed.keyColumn).toBe("orderNo");
    expect(parsed.vectorStrategy).toBe("row");
  });

  it("PATCH 不允许修改 keyColumn（显式拒绝，不静默忽略）", () => {
    expect(() =>
      UpdateDatabaseRequestSchema.parse({ columns: [{ name: "orderNo" }], keyColumn: "title" }),
    ).toThrow();
    expect(
      UpdateDatabaseRequestSchema.parse({ columns: [{ name: "orderNo" }] }).columns,
    ).toHaveLength(1);
  });

  it("未指定 keyColumn：保持追加语义（字段为空）", () => {
    const parsed = CreateDatabaseRequestSchema.parse(base);
    expect(parsed.keyColumn).toBeUndefined();
  });
});
