import { describe, expect, it } from "vitest"
import { businessStages } from "./automation-apps"
import type { AutomationStep } from "./automation-apps"

const step = (id: string, businessStage?: string): AutomationStep => ({
  id, title: `操作${id}`, ...(businessStage ? { businessStage } : {}),
  operation: { type: "browser", action: "click", selector: "#button" },
})

describe("业务阶段", () => {
  it("只合并连续的同名业务阶段，保留动作顺序和索引", () => {
    const result = businessStages([step("1", "导出订单"), step("2", "导出订单"), step("3", "整理表格"), step("4", "导出订单")])
    expect(result.map((stage) => stage.title)).toEqual(["导出订单", "整理表格", "导出订单"])
    expect(result.map((stage) => stage.entries.map(({ index }) => index))).toEqual([[0, 1], [2], [3]])
  })
  it("旧应用中没有业务阶段时，每个动作保留原有显示", () => {
    expect(businessStages([step("1"), step("2")]).map((stage) => stage.title)).toEqual(["操作1", "操作2"])
  })
})
