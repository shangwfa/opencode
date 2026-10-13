/**
 * pgvector filter 转换纯逻辑测试（无需数据库）。
 */
import { describe, expect, it } from "bun:test"
import { buildDeleteFilterQuery, buildFilterQuery } from "../src/rag/knowledge-base/vector/filter.js"

describe("buildFilterQuery", () => {
  it("无 filter 时返回空 SQL", () => {
    const r = buildFilterQuery(undefined, -1, 10)
    expect(r.sql).toBe("")
    expect(r.values).toEqual([-1, 10])
  })

  it("等值简写 {field: value}", () => {
    const r = buildFilterQuery({ documentId: "doc1" }, 0.5, 5)
    expect(r.sql).toBe("WHERE metadata#>>'{documentId}' = $3")
    expect(r.values).toEqual([0.5, 5, "doc1"])
  })

  it("嵌套字段路径 a.b → {a,b}", () => {
    const r = buildFilterQuery({ "meta.source": "x" }, -1, 10)
    expect(r.sql).toContain("metadata#>>'{meta,source}'")
  })

  it("比较操作符 $gt/$lte", () => {
    const r = buildFilterQuery({ score: { $gt: 1 }, rank: { $lte: 3 } }, -1, 10)
    expect(r.sql).toContain("::numeric > $3::numeric")
    expect(r.sql).toContain("::numeric <= $4::numeric")
    expect(r.values).toEqual([-1, 10, 1, 3])
  })

  it("$in 数组操作符", () => {
    const r = buildFilterQuery({ type: { $in: ["a", "b"] } }, -1, 10)
    expect(r.sql).toContain("= ANY($3::text[])")
    expect(r.values[2]).toEqual(["a", "b"])
  })

  it("$exists 操作符无需参数", () => {
    const r = buildFilterQuery({ tag: { $exists: true } }, -1, 10)
    expect(r.sql).toBe("WHERE metadata ? 'tag'")
    expect(r.values).toEqual([-1, 10])
  })

  it("$and / $or 逻辑组合", () => {
    const r = buildFilterQuery({ $or: [{ a: "1" }, { b: "2" }] }, -1, 10)
    expect(r.sql).toBe("WHERE (metadata#>>'{a}' = $3 OR metadata#>>'{b}' = $4)")
    expect(r.values).toEqual([-1, 10, "1", "2"])
  })

  it("$not 逻辑组合", () => {
    const r = buildFilterQuery({ $not: { a: "1" } }, -1, 10)
    expect(r.sql).toBe("WHERE NOT (metadata#>>'{a}' = $3)")
  })

  it("非法操作符抛错", () => {
    expect(() => buildFilterQuery({ a: { $bogus: 1 } }, -1, 10)).toThrow("Invalid operator")
  })
})

describe("buildDeleteFilterQuery", () => {
  it("参数从 $1 开始（无 minScore/topK 占位）", () => {
    const r = buildDeleteFilterQuery({ documentId: "doc1" })
    expect(r.sql).toBe("WHERE metadata#>>'{documentId}' = $1")
    expect(r.values).toEqual(["doc1"])
  })
})
