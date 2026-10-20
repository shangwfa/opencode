import { describe, expect, test } from "vitest"
import { selectAppRequirements, type AppRequirement } from "./app-requirements"

const requirement = (index: number): AppRequirement => ({
  id: `req_${index}`, title: `看板 ${index}`, status: "open", kind: null, priority: null,
  timeCreated: index, timeUpdated: index, sessionId: `ses_${index}`,
})

describe("应用需求列表", () => {
  test("管理列表保留全部需求，按最近更新时间排序且不修改输入", () => {
    const items = Array.from({ length: 15 }, (_, index) => requirement(index))
    const result = selectAppRequirements(items)
    expect(result).toHaveLength(15)
    expect(result[0].id).toBe("req_14")
    expect(items[0].id).toBe("req_0")
  })
  test("侧栏只保留最近 10 条", () => {
    const result = selectAppRequirements(Array.from({ length: 15 }, (_, index) => requirement(index)), "", 10)
    expect(result.map((item) => item.id)).toEqual(Array.from({ length: 10 }, (_, index) => `req_${14 - index}`))
  })
  test("支持标题、ID 搜索，忽略大小写和首尾空格", () => {
    const items = [{ ...requirement(1), title: "Dashboard 页面" }, requirement(2)]
    expect(selectAppRequirements(items, "  DASHBOARD ").map((item) => item.id)).toEqual(["req_1"])
    expect(selectAppRequirements(items, "REQ_2").map((item) => item.id)).toEqual(["req_2"])
    expect(selectAppRequirements(items, "不存在")).toEqual([])
  })
  test("无会话的需求仍保留，空列表可正常显示", () => {
    expect(selectAppRequirements([{ ...requirement(1), sessionId: null }])).toHaveLength(1)
    expect(selectAppRequirements([], "", 10)).toEqual([])
  })
})
