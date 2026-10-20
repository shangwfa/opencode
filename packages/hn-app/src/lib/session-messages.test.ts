import { describe, expect, test } from "vitest"
import { timelineMessages, type SessionMessage } from "./session-messages"

describe("会话时间线投影", () => {
  test("空回复也保留错误信息，刷新后仍可展示失败原因", () => {
    const error = { type: "provider.auth", status: 403, message: "模型服务拒绝访问" }
    const result = timelineMessages("ses_1", [{ id: "msg_error", type: "assistant", time: { created: 2, completed: 3 }, content: [], error }])
    expect(result[0].info).toMatchObject({ role: "assistant", error })
    expect(result[0].parts).toEqual([])
  })
  const user: SessionMessage = { id: "msg_user", type: "user", time: { created: 1 }, text: "hi" }
  test("历史用户气泡去掉平台追加提示，保留需求原文", () => {
    const hint = "工作区 /workspace 已经由平台完成代码拉取与分支切换，请勿重复 git clone / git init；直接基于现有代码开发。"
    expect(timelineMessages("ses_1", [{ ...user, text: `帮我开发个数据看板页面\n\n${hint}` }])[0].parts[0]).toMatchObject({ text: "帮我开发个数据看板页面" })
    const original = `请解释这句话：${hint}\n这是我自己的问题`
    expect(timelineMessages("ses_1", [{ ...user, text: original }])[0].parts[0]).toMatchObject({ text: original })
  })
  test("读取回复与工具执行结果，忽略平台 shell 和 synthetic 消息", () => {
    const items = timelineMessages("ses_1", [
      { id: "msg_prepare_1", type: "shell", time: { created: 0 } },
      { id: "msg_context", type: "synthetic", text: "平台命令", time: { created: 0 } },
      user,
      { id: "msg_reply", type: "assistant", promptMessageID: user.id, time: { created: 2, completed: 3 }, content: [
        { type: "text", text: "收到" },
        { type: "tool", name: "read", id: "call_1", state: { status: "completed", input: { path: "/workspace/README.md" }, content: [{ type: "text", text: "文件内容" }] } },
      ] },
    ])
    expect(items).toHaveLength(2)
    expect(items[1].info).toMatchObject({ role: "assistant", parentID: "msg_user" })
    expect(items[1].parts[0]).toMatchObject({ type: "text", text: "收到" })
    expect(items[1].parts[1]).toMatchObject({ type: "tool", tool: "read", state: { status: "completed", output: "文件内容" } })
  })
  test("稳定的内容块 ID 支持流式快照替换", () => {
    const message: SessionMessage = { id: "msg_reply", type: "assistant", time: { created: 2 }, content: [{ type: "text", text: "收" }] }
    const initial = timelineMessages("ses_1", [message])[0].parts[0]
    const final = timelineMessages("ses_1", [{ ...message, content: [{ type: "text", text: "收到" }] }])[0].parts[0]
    expect(initial.id).toBe(final.id)
    expect(final).toMatchObject({ text: "收到" })
  })
})
