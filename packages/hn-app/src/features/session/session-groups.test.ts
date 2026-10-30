import { expect, it } from "vitest"
import { groupSessions, type SessionRow } from "./session-groups"

const now = new Date(2026, 9, 30, 12)
const session = (id: string, created?: number): SessionRow => ({ id, time: { created } })

it("今天、昨天、更早分组，组内创建时间倒序且不修改原数组", () => {
  const sessions = [
    session("old", new Date(2026, 9, 1).getTime()),
    session("morning", new Date(2026, 9, 30, 8).getTime()),
    session("yesterday", new Date(2026, 9, 29, 23, 59).getTime()),
    session("noon", now.getTime()),
  ]
  expect(groupSessions(sessions, now).map((group) => ({ label: group.label, ids: group.sessions.map((s) => s.id) }))).toEqual([
    { label: "今天", ids: ["noon", "morning"] },
    { label: "昨天", ids: ["yesterday"] },
    { label: "更早", ids: ["old"] },
  ])
  expect(sessions.map((s) => s.id)).toEqual(["old", "morning", "yesterday", "noon"])
})

it("空列表不显示日期分组，单个分组不生成空标题", () => {
  expect(groupSessions([], now)).toEqual([])
  expect(groupSessions([session("today", now.getTime())], now).map((g) => g.label)).toEqual(["今天"])
})

it("按本地自然日而非滚动24小时分组，支持跨月和跨年", () => {
  for (const date of [new Date(2026, 10, 1, 0, 1), new Date(2027, 0, 1, 0, 1)]) {
    const yesterday = new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1, 23, 59)
    expect(groupSessions([session("previous-day", yesterday.getTime())], date)[0]?.label).toBe("昨天")
  }
})

it("缺失与无效日期归入更早，相同时间保持原顺序", () => {
  const sessions = [session("missing"), { id: "no-time" }, session("invalid", NaN)]
  expect(groupSessions(sessions, now)[0]).toEqual({ label: "更早", sessions })
  const sameTime = [session("a", now.getTime()), session("b", now.getTime())]
  expect(groupSessions(sameTime, now)[0]?.sessions).toEqual(sameTime)
})
