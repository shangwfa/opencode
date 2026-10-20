import { describe, expect, test } from "vitest"
import { applyDataEvent, type DataState } from "./data"
import type { Message, Part } from "@/types/opencode"

const state = (): DataState => ({
  message: {},
  part: {},
  session_status: {},
  session_error: {},
  loaded: {},
  hidden: {},
})

const user = (id: string, sessionID = "ses_1"): Message =>
  ({
    id,
    sessionID,
    role: "user",
    agent: "build",
    model: { providerID: "p", modelID: "m" },
    time: { created: 1 },
  }) as Message

const assistant = (id: string, parentID: string, sessionID = "ses_1"): Message =>
  ({
    id,
    sessionID,
    role: "assistant",
    parentID,
    agent: "build",
    modelID: "m",
    providerID: "p",
    time: { created: 2 },
  }) as Message

const textPart = (messageID: string, text: string): Part =>
  ({ id: `prt_${messageID}`, messageID, sessionID: "ses_1", type: "text", text }) as Part

const updated = (info: Message) => ({ type: "message.updated", properties: { info } })
const partUpdated = (part: Part) => ({ type: "message.part.updated", properties: { part } })

describe("applyDataEvent 系统编排消息过滤", () => {
  test("执行失败恢复 idle 并保存错误，而不是永久思考中", () => {
    let next = applyDataEvent(state(), { type: "session.execution.started", properties: { sessionID: "ses_1" } })
    expect(next.session_status.ses_1.type).toBe("busy")
    next = applyDataEvent(next, { type: "session.execution.failed", properties: { sessionID: "ses_1", error: { message: "模型不可用" } } })
    expect(next.session_status.ses_1.type).toBe("idle")
    expect(next.session_error.ses_1).toEqual({ message: "模型不可用" })
  })
  test("丢弃 msg_prepare_* 的编排消息", () => {
    const next = applyDataEvent(state(), updated(user("msg_prepare_abc")))
    expect(next.message["ses_1"]).toBeUndefined()
  })

  test("丢弃由编排消息触发的 assistant 回复", () => {
    const next = applyDataEvent(state(), updated(assistant("msg_reply", "msg_prepare_abc")))
    expect(next.message["ses_1"]).toBeUndefined()
  })

  test("保留普通对话消息", () => {
    const next = applyDataEvent(state(), updated(user("msg_user")))
    expect(next.message["ses_1"]?.map((m) => m.id)).toEqual(["msg_user"])
  })

  test("先收到消息、后收到 legacy shell 文案：消息被移除", () => {
    let next = applyDataEvent(state(), updated(user("msg_legacy")))
    next = applyDataEvent(next, updated(assistant("msg_reply", "msg_legacy")))
    expect(next.message["ses_1"]).toHaveLength(2)

    next = applyDataEvent(next, partUpdated(textPart("msg_legacy", "The following tool was executed by the user")))

    expect(next.hidden["msg_legacy"]).toBe(true)
    expect(next.message["ses_1"]).toEqual([])
  })

  test("先收到 legacy shell 文案、后收到消息：消息被忽略", () => {
    let next = applyDataEvent(state(), partUpdated(textPart("msg_legacy", "The following tool was executed by the user")))
    next = applyDataEvent(next, updated(user("msg_legacy")))
    next = applyDataEvent(next, updated(assistant("msg_reply", "msg_legacy")))

    expect(next.message["ses_1"]).toBeUndefined()
  })

  test("隐藏消息的后续 part 更新不再写入", () => {
    let next = applyDataEvent(state(), partUpdated(textPart("msg_legacy", "The following tool was executed by the user")))
    next = applyDataEvent(next, partUpdated(textPart("msg_legacy", "still hidden")))

    expect(next.part["msg_legacy"]).toBeUndefined()
  })
})
