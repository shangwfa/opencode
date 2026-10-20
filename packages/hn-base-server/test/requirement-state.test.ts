import { describe, expect, it } from "bun:test"
import {
  allowedTransitions,
  canTransition,
  isRequirementStatus,
  transitionError,
  type RequirementStatus,
} from "../src/lib/requirement-state.js"

describe("requirement-state/线性流转", () => {
  it("正常推进：draft → open → in_progress → pending_publish → done", () => {
    expect(canTransition("draft", "open")).toBe(true)
    expect(canTransition("open", "in_progress")).toBe(true)
    expect(canTransition("in_progress", "pending_publish")).toBe(true)
    expect(canTransition("pending_publish", "done")).toBe(true)
  })

  it("允许回退：pending_publish → in_progress → open", () => {
    expect(canTransition("pending_publish", "in_progress")).toBe(true)
    expect(canTransition("in_progress", "open")).toBe(true)
  })

  it("不允许跳态：open → done", () => {
    expect(canTransition("open", "done")).toBe(false)
    expect(canTransition("draft", "in_progress")).toBe(false)
    expect(canTransition("in_progress", "done")).toBe(false)
  })

  it("任意状态可归档，归档是终态", () => {
    for (const s of ["draft", "open", "in_progress", "pending_publish", "done"] as RequirementStatus[]) {
      expect(canTransition(s, "archived")).toBe(true)
    }
    expect(canTransition("archived", "open")).toBe(false)
    expect(allowedTransitions("archived")).toEqual([])
  })

  it("同状态视为合法（幂等更新）", () => {
    expect(canTransition("open", "open")).toBe(true)
  })
})

describe("requirement-state/错误文案", () => {
  it("非法迁移给出允许列表", () => {
    const message = transitionError("open", "done")
    expect(message).toContain("不能从")
    expect(message).toContain("进行中")
  })

  it("终态给出明确提示", () => {
    expect(transitionError("archived", "open")).toContain("终态")
  })

  it("合法迁移返回 undefined", () => {
    expect(transitionError("open", "in_progress")).toBeUndefined()
  })
})

describe("requirement-state/类型守卫", () => {
  it("识别合法状态", () => {
    expect(isRequirementStatus("pending_publish")).toBe(true)
    expect(isRequirementStatus("pending")).toBe(false)
    expect(isRequirementStatus("")).toBe(false)
  })
})
