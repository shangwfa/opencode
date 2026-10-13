/**
 * DatabaseService 单元测试：mock drizzle `db` 与 pg `pool`，覆盖 SQL 拼装与回填路径。
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

/** 避免加载真实 knowledge-base index（会要求 DATABASE_URL） */
mock.module("../../rag/knowledge-base/index.js", () => ({
  keywordSearchService: {
    createPerformanceIndexes: mock().mockResolvedValue(undefined),
  },
}));

const poolConnect = mock();
const dbSelect = mock();

mock.module("../db/index.js", () => ({
  schemaName: "test_schema",
  pool: { connect: poolConnect },
  db: { select: dbSelect },
  databaseBases: { id: { name: "id" } },
}));

import type { SearchResultItem } from "../../rag/knowledge-base/index.js";

// 被测模块：mock 注册后动态导入
const { DatabaseService } = await import("./database.service");

function registryRow(overrides: Partial<Record<string, unknown>> = {}) {
  const now = new Date();
  return {
    id: "ds1",
    name: "Dataset",
    description: null,
    embeddingModel: "openai/text-embedding-3-small",
    defaultChunkStrategy: "recursive",
    defaultChunkConfig: {},
    indexName: null,
    indexDimension: 1536,
    indexCreated: 0,
    indexCreatedAt: null,
    dataTableName: "rd_tbl_ds1",
    columnDefinitions: [{ name: "col_a" }],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function mockDrizzleGetDatabaseRow(row: Record<string, unknown> | null) {
  const limit = mock(() => Promise.resolve(row ? [row] : []));
  const where = mock(() => ({ limit }));
  const from = mock(() => ({ where }));
  dbSelect.mockReturnValue({ from } as never);
}

function createPoolClient(
  queryImpl: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>,
) {
  return {
    query: mock((sql: string, params?: unknown[]) => queryImpl(sql, params)),
    release: mock(),
  };
}

describe("DatabaseService", () => {
  let service: InstanceType<typeof DatabaseService>;

  beforeEach(() => {
    mock.clearAllMocks();
    service = new DatabaseService({} as never, {} as never);
  });

  describe("hydrateSearchResults", () => {
    it("空结果直接返回空数组", async () => {
      const out = await service.hydrateSearchResults("ds1", []);
      expect(out).toEqual([]);
      expect(poolConnect).not.toHaveBeenCalled();
    });

    it("按 metadata.rowId 批量查库并回填行", async () => {
      mockDrizzleGetDatabaseRow(registryRow());

      const client = createPoolClient(async (sql, params) => {
        if (sql.includes("SET search_path")) return { rows: [] };
        if (sql.includes("WHERE id = ANY($1::varchar[])")) {
          const ids = params![0] as string[];
          expect(ids).toEqual(["r1", "r2"]);
          return {
            rows: [
              { id: "r1", col_a: "a1" },
              { id: "r2", col_a: "a2" },
            ],
          };
        }
        return { rows: [] };
      });
      poolConnect.mockResolvedValue(client as never);

      const results: SearchResultItem[] = [
        {
          id: "r1__c0",
          text: "c1",
          score: 0.9,
          metadata: { rowId: "r1", text: "c1" },
          documentId: "",
        },
        {
          id: "r2__c0",
          text: "c2",
          score: 0.8,
          metadata: { rowId: "r2", text: "c2" },
          documentId: "",
        },
      ];

      const out = await service.hydrateSearchResults("ds1", results);

      expect(out).toHaveLength(2);
      expect(out[0].documentId).toBe("r1");
      expect(out[0].row).toEqual({ id: "r1", col_a: "a1" });
      expect(out[1].documentId).toBe("r2");
      expect(out[1].row).toEqual({ id: "r2", col_a: "a2" });
      expect(client.release).toHaveBeenCalled();
    });

    it("无 rowId 时从 chunk 向量 id 解析行 id", async () => {
      mockDrizzleGetDatabaseRow(registryRow());

      const client = createPoolClient(async (sql, params) => {
        if (sql.includes("SET search_path")) return { rows: [] };
        if (sql.includes("WHERE id = ANY($1::varchar[])")) {
          expect(params![0]).toEqual(["abc"]);
          return { rows: [{ id: "abc", col_a: "x" }] };
        }
        return { rows: [] };
      });
      poolConnect.mockResolvedValue(client as never);

      const out = await service.hydrateSearchResults("ds1", [
        {
          id: "abc__c3",
          text: "t",
          score: 1,
          metadata: { text: "t" },
          documentId: "",
        },
      ]);

      expect(out[0].documentId).toBe("abc");
      expect(out[0].row).toEqual({ id: "abc", col_a: "x" });
    });
  });

  describe("searchRowsByFilter", () => {
    it("数据集不存在时抛出", async () => {
      mockDrizzleGetDatabaseRow(null);
      await expect(
        service.searchRowsByFilter("missing", { col_a: "x" }, 10),
      ).rejects.toThrow("Dataset missing not found");
    });

    it("字符串列使用 ILIKE 子串条件且 idOnly 时只 SELECT id", async () => {
      mockDrizzleGetDatabaseRow(registryRow());

      const client = createPoolClient(async (sql, params) => {
        if (sql.includes("SET search_path")) return { rows: [] };
        expect(sql).toContain(`SELECT id FROM test_schema.rd_tbl_ds1`);
        expect(sql).toContain(`trim("col_a"::text) ILIKE $1 ESCAPE`);
        expect(sql).toContain("ORDER BY updated_at DESC LIMIT 10");
        expect(params).toEqual(["%foo\\%bar%"]);
        return { rows: [{ id: "row-1" }] };
      });
      poolConnect.mockResolvedValue(client as never);

      const rows = await service.searchRowsByFilter(
        "ds1",
        { col_a: "foo%bar" },
        10,
        { idOnly: true },
      );

      expect(rows).toEqual([{ id: "row-1" }]);
    });

    it("未知 filter 键抛出", async () => {
      mockDrizzleGetDatabaseRow(registryRow());
      await expect(
        service.searchRowsByFilter("ds1", { bad_col: "x" } as Record<string, unknown>, 10),
      ).rejects.toThrow("Unknown filter key");
      expect(poolConnect).not.toHaveBeenCalled();
    });
  });

  describe("listRows", () => {
    it("支持按动态表字段过滤并保留分页返回结构", async () => {
      mockDrizzleGetDatabaseRow(registryRow());

      const client = createPoolClient(async (sql, params) => {
        if (sql.includes("SET search_path")) return { rows: [] };
        if (sql.includes("COUNT(*)::int")) {
          expect(sql).toContain(`FROM test_schema.rd_tbl_ds1 WHERE trim("col_a"::text) ILIKE $1 ESCAPE`);
          expect(params).toEqual(["%foo%"]);
          return { rows: [{ c: 1 }] };
        }
        expect(sql).toContain(`SELECT * FROM test_schema.rd_tbl_ds1 WHERE trim("col_a"::text) ILIKE $1 ESCAPE`);
        expect(sql).toContain("ORDER BY created_at DESC LIMIT $2 OFFSET $3");
        expect(params).toEqual(["%foo%", 20, 20]);
        return { rows: [{ id: "r2", col_a: "foobar" }] };
      });
      poolConnect.mockResolvedValue(client as never);

      const out = await service.listRows("ds1", {
        page: 2,
        pageSize: 20,
        filter: { col_a: "foo" },
      });

      expect(out).toEqual({
        items: [{ id: "r2", col_a: "foobar" }],
        total: 1,
        page: 2,
        pageSize: 20,
        totalPages: 1,
      });
    });
  });

  describe("getRow", () => {
    it("按主键查询并返回一行", async () => {
      mockDrizzleGetDatabaseRow(registryRow());

      const client = createPoolClient(async (sql, params) => {
        if (sql.includes("SET search_path")) return { rows: [] };
        expect(sql).toContain("WHERE id = $1 LIMIT 1");
        expect(sql).not.toContain("ORDER BY updated_at");
        expect(params).toEqual(["rid"]);
        return { rows: [{ id: "rid", col_a: "val" }] };
      });
      poolConnect.mockResolvedValue(client as never);

      const row = await service.getRow("ds1", "rid");
      expect(row).toEqual({ id: "rid", col_a: "val" });
    });
  });
});
