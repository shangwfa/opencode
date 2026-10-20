import { describe, expect, it } from "vitest"
import type { Part } from "@/types/opencode"
import { displayText, hasStreamingReasoningPart } from "./session-timeline"

const reasoning = (extra: Partial<Extract<Part, { type: "reasoning" }>> = {}): Part =>
  ({ id: "pr_1", messageID: "msg_1", sessionID: "ses_1", type: "reasoning", text: "...", ...extra }) as Part

describe("hasStreamingReasoningPart", () => {
  it("无 reasoning → false", () => {
    expect(hasStreamingReasoningPart({})).toBe(false)
    expect(hasStreamingReasoningPart({ m: [{ id: "p1", type: "text", text: "hi" } as Part] })).toBe(false)
  })

  it("已结束（time.end 存在）→ false", () => {
    const part = reasoning({ time: { start: 1, end: 2 } })
    expect(hasStreamingReasoningPart({ m: [part] })).toBe(false)
  })

  it("流式中（无 time.end）→ true", () => {
    expect(hasStreamingReasoningPart({ m: [reasoning({ time: { start: 1 } })] })).toBe(true)
  })

  it("无 time 字段按流式处理 → true（与 ReasoningBlock 判定一致）", () => {
    expect(hasStreamingReasoningPart({ m: [reasoning()] })).toBe(true)
  })

  it("流式但尚无文本也算（块内标题行已在表达思考态）", () => {
    expect(hasStreamingReasoningPart({ m: [reasoning({ text: "", time: { start: 1 } })] })).toBe(true)
  })

  it("多消息中任一流式即命中", () => {
    const parts = { a: [reasoning({ id: "p1", time: { start: 1, end: 2 } })], b: [reasoning({ id: "p2", time: { start: 3 } })] }
    expect(hasStreamingReasoningPart(parts)).toBe(true)
  })
})

describe("displayText", () => {
  const text = (value: string, synthetic?: boolean): Part =>
    ({ id: `p_${value}`, messageID: "msg_1", sessionID: "ses_1", type: "text", text: value, synthetic }) as Part

  it("拼接普通文本", () => {
    expect(displayText([text("第一行"), text("第二行")])).toBe("第一行\n第二行")
  })

  it("不展示 synthetic 隐藏上下文", () => {
    expect(displayText([text("需求原文"), text("工作区已就绪，请勿 clone", true)])).toBe("需求原文")
  })
})
