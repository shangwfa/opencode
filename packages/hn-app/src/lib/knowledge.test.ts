import { describe, expect, it } from "vitest"
import {
  defaultCapabilities,
  detailTabs,
  filterBases,
  selectableCapabilities,
  type KnowledgeBaseSummary,
} from "./knowledge"

const base = (over: Partial<KnowledgeBaseSummary> = {}): KnowledgeBaseSummary => ({
  id: "kb_1",
  name: "产品帮助库",
  sourceType: "documents",
  capabilities: ["rag"],
  documentCount: 1,
  chunkCount: 1,
  status: "ready",
  timeUpdated: 1,
  ...over,
})

describe("知识库纯逻辑", () => {
  it("文档库默认 RAG，结构化默认混合检索", () => {
    expect(defaultCapabilities("documents")).toEqual(["rag"])
    expect(defaultCapabilities("structured")).toEqual(["hybrid"])
    expect(selectableCapabilities("documents").map((item) => item.id)).toEqual(["rag", "graph", "wiki"])
    expect(selectableCapabilities("structured").map((item) => item.id)).toEqual(["hybrid", "graph"])
    expect(selectableCapabilities("documents").every((item) => !item.required)).toBe(true)
    expect(detailTabs("documents", [])).toEqual(["docs", "tasks"])
  })

  it("Tab 显隐由数据源与启用能力决定", () => {
    expect(detailTabs("documents", ["rag"])).toEqual(["docs", "recall", "tasks"])
    expect(detailTabs("documents", ["rag", "graph", "wiki"])).toEqual(["docs", "recall", "graph", "wiki", "tasks"])
    expect(detailTabs("structured", ["hybrid"])).toEqual(["docs", "recall", "tasks"])
    expect(detailTabs("structured", ["hybrid", "graph"])).toEqual(["docs", "recall", "graph", "tasks"])
    expect(detailTabs("documents", ["graph"])).toEqual(["docs", "graph", "tasks"])
  })

  it("按关键词与数据源筛选", () => {
    const bases = [base(), base({ id: "kb_2", name: "运营指标库", sourceType: "structured" })]
    expect(filterBases(bases, { sourceType: "structured" }).map((item) => item.id)).toEqual(["kb_2"])
    expect(filterBases(bases, { query: "帮助" }).map((item) => item.id)).toEqual(["kb_1"])
    expect(filterBases(bases, {})).toHaveLength(2)
  })
})
