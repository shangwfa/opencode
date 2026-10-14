import { expect, test } from "bun:test"
import { findIndexCollisions } from "./index-identity-audit"

test("识别 data-table 与 RAG 的共享索引", () => {
  expect(findIndexCollisions([
    { domain: "data-table", id: "orders" },
    { domain: "rag", id: "kb_orders" },
  ])).toHaveLength(1)
})

test("识别不同原始 ID 归一化碰撞", () => {
  expect(findIndexCollisions([
    { domain: "data-table", id: "A-B" },
    { domain: "data-table", id: "a_b" },
  ])[0].indexName).toBe("kb_a_b")
})

test("优先使用注册表物理身份，不把已隔离索引误报为共享", () => {
  expect(findIndexCollisions([
    { domain: "data-table", id: "orders", indexName: "dt_vec_opaque" },
    { domain: "rag", id: "kb_orders", indexName: "kb_orders" },
  ])).toEqual([])
})

test("空注册表没有碰撞", () => {
  expect(findIndexCollisions([])).toEqual([])
})
