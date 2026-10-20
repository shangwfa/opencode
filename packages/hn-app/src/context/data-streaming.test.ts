import { describe, expect, test } from "vitest"
import { applyDataEvent, mergeStreamedParts, type DataState } from "./data"
import { timelineMessages } from "@/lib/session-messages"

const empty = (): DataState => ({ message: {}, part: {}, session_status: {}, session_error: {}, loaded: {}, hidden: {} })
const emit = (state: DataState, type: string, extra: Record<string, unknown> = {}) => applyDataEvent(state, {
  type, properties: { sessionID: "ses_stream", assistantMessageID: "msg_stream", ordinal: 0, ...extra },
})
const step = () => emit(empty(), "session.step.started", { agent: "build", model: { id: "model", providerID: "provider" }, promptMessageID: "msg_user" })

describe("直接消费思考与正文 SSE 增量", () => {
  test("step 失败立即保留错误和完成时间，不等待快照", () => {
    const error = { status: 403, message: "模型服务拒绝访问" }
    const state = emit(step(), "session.step.failed", { error })
    expect(state.message.ses_stream[0]).toMatchObject({ role: "assistant", error })
    expect(state.message.ses_stream[0].time.completed).toBeDefined()
  })
  test.each(["reasoning", "text"])("%s 在 ended 之前即可看到逐段文本", (kind) => {
    let state = emit(step(), `session.${kind}.started`)
    state = emit(state, `session.${kind}.delta`, { delta: "第一" })
    expect(state.part.msg_stream[0]).toMatchObject({ type: kind, text: "第一" })
    state = emit(state, `session.${kind}.delta`, { delta: "第二" })
    expect(state.part.msg_stream[0]).toMatchObject({ text: "第一第二" })
    const part = state.part.msg_stream[0]
    expect((part.type === "text" || part.type === "reasoning") && part.time?.end === undefined).toBe(true)
  })

  test("结束事件完整值替换增量，重复 ended 不会重复追加", () => {
    let state = emit(step(), "session.reasoning.delta", { delta: "未完成" })
    state = emit(state, "session.reasoning.ended", { text: "完整思考" })
    state = emit(state, "session.reasoning.ended", { text: "完整思考" })
    expect(state.part.msg_stream).toHaveLength(1)
    expect(state.part.msg_stream[0]).toMatchObject({ text: "完整思考" })
    const part = state.part.msg_stream[0]
    expect((part.type === "text" || part.type === "reasoning") && part.time?.end !== undefined).toBe(true)
    expect(emit(state, "session.reasoning.delta", { delta: "迟到增量" })).toBe(state)
  })

  test("思考、正文与不同 ordinal 不串流", () => {
    let state = emit(step(), "session.reasoning.delta", { delta: "思考" })
    state = emit(state, "session.text.delta", { delta: "回复" })
    state = emit(state, "session.reasoning.delta", { ordinal: 1, delta: "下一段" })
    expect(state.part.msg_stream.map((part) => "text" in part ? part.text : "")).toEqual(["思考", "回复", "下一段"])
  })

  test("其他消息和会话的增量独立保存", () => {
    let state = emit(step(), "session.text.delta", { delta: "当前会话" })
    state = emit(state, "session.text.delta", { sessionID: "ses_other", assistantMessageID: "msg_other", delta: "另一个会话" })
    expect(state.part.msg_stream[0]).toMatchObject({ text: "当前会话", sessionID: "ses_stream" })
    expect(state.part.msg_other[0]).toMatchObject({ text: "另一个会话", sessionID: "ses_other" })
  })

  test("快照与流式块使用相同 ID，滞后快照不会覆盖已收到文字", () => {
    const state = emit(step(), "session.reasoning.delta", { delta: "实时思考" })
    const snapshot = timelineMessages("ses_stream", [{ id: "msg_stream", type: "assistant", time: { created: 1 }, content: [{ type: "reasoning", text: "" }] }])[0].parts
    expect(mergeStreamedParts(snapshot, state.streamed?.msg_stream ?? [])).toEqual(state.part.msg_stream)
    expect(mergeStreamedParts([], state.streamed?.msg_stream ?? [])).toEqual(state.part.msg_stream)
  })

  test("重复 step.started 不创建重复消息", () => {
    const state = step()
    expect(emit(state, "session.step.started")).toBe(state)
    expect(state.message.ses_stream[0]).toMatchObject({ role: "assistant", parentID: "msg_user" })
  })
})
