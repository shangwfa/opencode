/**
 * 仪表盘聚合逻辑单测。
 * aggregate.ts 从源项目 1:1 迁移（仅类型 import 路径调整），此处锁定其行为：
 * 状态/类型/优先级/仓库/人员/合并请求各维度计数、时间范围过滤、趋势序列的补零与粒度。
 */
import { describe, expect, it } from "vitest"
import type { AggregateRequirement, MergeRecord } from "@/api/requirement/types"
import {
  completionRate,
  countByCreator,
  countByKind,
  countByMergeState,
  countByPriority,
  countByRepo,
  countByStatus,
  filterByTimeRange,
  mergeStateItems,
  repoOptions,
  trendByDay,
} from "./aggregate"

const DAY = 86_400_000

/** 构造 merge record：state 之外字段对被测逻辑无意义 */
function mr(state: MergeRecord["state"] | "weird"): MergeRecord {
  return { state } as MergeRecord
}

function req(partial: Partial<AggregateRequirement> & { id: string }): AggregateRequirement {
  return {
    title: partial.id,
    status: "open",
    created_at: new Date().toISOString(),
    target_gitlab: "",
    creator_uuid: "",
    creator_nick_name: "",
    opencode_session_id: "",
    workflow_id: "",
    version: {} as AggregateRequirement["version"],
    ...partial,
  }
}

describe("aggregate/countByStatus", () => {
  it("按 open / pending_publish / done 分类，其余归 other", () => {
    const r = countByStatus([
      req({ id: "1", status: "open" }),
      req({ id: "2", status: "pending_publish" }),
      req({ id: "3", status: "done" }),
      req({ id: "4", status: "done" }),
      req({ id: "5", status: "archive" }),
    ])
    expect(r).toEqual({ open: 1, pending_publish: 1, done: 2, other: 1 })
  })

  it("空输入全为 0", () => {
    expect(countByStatus([])).toEqual({ open: 0, pending_publish: 0, done: 0, other: 0 })
  })
})

describe("aggregate/countByKind & countByPriority", () => {
  it("按已知 label 映射，缺失归未分类/未设置", () => {
    const kinds = countByKind([
      req({ id: "1", kind: "regular" }),
      req({ id: "2", kind: "bugfix" }),
      req({ id: "3", kind: undefined }),
    ])
    expect(kinds.map((k) => [k.label, k.value])).toEqual([
      ["常规", 1],
      ["Bugfix", 1],
      ["未分类", 1],
    ])
  })

  it("优先级带中文 label 并按数量降序", () => {
    const p = countByPriority([
      req({ id: "1", priority: "high" }),
      req({ id: "2", priority: "high" }),
      req({ id: "3", priority: "low" }),
      req({ id: "4", priority: undefined }),
    ])
    expect(p[0]).toMatchObject({ key: "high", label: "高", value: 2 })
    expect(p.map((x) => x.key)).toEqual(["high", "low", "unknown"])
  })
})

describe("aggregate/countByRepo & repoOptions", () => {
  const items = [
    req({ id: "1", target_gitlab: "https://gitlab.com/b/repo-a" }),
    req({ id: "2", target_gitlab: "  " }),
    req({ id: "3", target_gitlab: "https://gitlab.com/a/repo-b" }),
    req({ id: "4", target_gitlab: "https://gitlab.com/b/repo-a" }),
  ]

  it("空仓库归「未指定」，按数量降序", () => {
    expect(countByRepo(items).map((x) => [x.label, x.value])).toEqual([
      ["https://gitlab.com/b/repo-a", 2],
      ["未指定", 1],
      ["https://gitlab.com/a/repo-b", 1],
    ])
  })

  it("repoOptions 去重排序且不含空值", () => {
    expect(repoOptions(items)).toEqual(["https://gitlab.com/a/repo-b", "https://gitlab.com/b/repo-a"])
  })
})

describe("aggregate/countByCreator", () => {
  it("统计总数/已完成/完成率，按总数降序（并列时按首次出现顺序）", () => {
    const r = countByCreator([
      req({ id: "1", creator_nick_name: "甲", status: "done" }),
      req({ id: "2", creator_nick_name: "甲", status: "open" }),
      req({ id: "3", creator_nick_name: "乙", status: "open" }),
      req({ id: "4", creator_nick_name: " ", status: "open" }),
    ])
    expect(r).toEqual([
      { name: "甲", total: 2, done: 1, rate: 0.5 },
      { name: "乙", total: 1, done: 0, rate: 0 },
      { name: "未指定", total: 1, done: 0, rate: 0 },
    ])
  })

  it("空输入返回空数组", () => {
    expect(countByCreator([])).toEqual([])
  })
})

describe("aggregate/countByMergeState & mergeStateItems", () => {
  it("按 MR state 计数，忽略未知 state", () => {
    const r = countByMergeState([
      req({
        id: "1",
        merge_records: [
          mr("opened"),
          mr("merged"),
          mr("closed"),
          mr("weird"),
        ],
      }),
      req({ id: "2", merge_records: [mr("merged")] }),
      req({ id: "3" }),
    ])
    expect(r).toEqual({ opened: 1, merged: 2, closed: 1 })
  })

  it("items 固定顺序 Opened / Merged / Closed", () => {
    expect(mergeStateItems({ opened: 1, merged: 2, closed: 3 }).map((i) => i.key)).toEqual([
      "opened",
      "merged",
      "closed",
    ])
  })
})

describe("aggregate/filterByTimeRange", () => {
  const now = Date.now()
  const items = [
    req({ id: "old", created_at: new Date(now - 40 * DAY).toISOString() }),
    req({ id: "recent", created_at: new Date(now - 3 * DAY).toISOString() }),
    req({ id: "invalid", created_at: "not-a-date" }),
  ]

  it("all 原样返回（含非法日期）", () => {
    expect(filterByTimeRange(items, "all").map((i) => i.id)).toEqual(["old", "recent", "invalid"])
  })

  it("近 30 天只留窗口内且丢弃非法日期", () => {
    expect(filterByTimeRange(items, 30).map((i) => i.id)).toEqual(["recent"])
  })

  it("近 7 天同样过滤", () => {
    expect(filterByTimeRange(items, 7).map((i) => i.id)).toEqual(["recent"])
  })
})

describe("aggregate/trendByDay", () => {
  it("近 N 天按天补零，长度恰好 N", () => {
    const points = trendByDay([], 7)
    expect(points).toHaveLength(7)
    expect(points.every((p) => p.count === 0)).toBe(true)
  })

  it("把区间内数据落到对应日期，无数据的日期为 0", () => {
    const today = new Date()
    const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`
    const points = trendByDay([req({ id: "1", created_at: new Date().toISOString() }), req({ id: "2", created_at: new Date().toISOString() })], 7)
    expect(points).toHaveLength(7)
    expect(points.at(-1)).toEqual({ date: todayKey, count: 2 })
  })

  it("all 按月聚合，非法日期被跳过", () => {
    const points = trendByDay(
      [
        req({ id: "1", created_at: "2025-03-05T00:00:00Z" }),
        req({ id: "2", created_at: "2025-03-20T00:00:00Z" }),
        req({ id: "3", created_at: "bad" }),
      ],
      "all",
    )
    expect(points.some((p) => p.date === "2025-03" && p.count === 2)).toBe(true)
    expect(points.at(-1)?.date).toBe(`${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`)
  })

  it("all 空输入至少返回当月一点", () => {
    const points = trendByDay([], "all")
    expect(points).toHaveLength(1)
  })
})

describe("aggregate/completionRate", () => {
  it("done 占比百分数", () => {
    expect(completionRate([req({ id: "1", status: "done" }), req({ id: "2", status: "open" })])).toBe(50)
  })

  it("空列表为 0", () => {
    expect(completionRate([])).toBe(0)
  })
})