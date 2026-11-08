import { describe, expect, test } from "bun:test"
import { AutomationInstruction as I } from "@opencode/schema/automation-instruction"
import { contentHash, instructionDefinition, instructionPrompt, requiresConfirmation, secretFinding, technicalInstructionFinding, verificationPath } from "../src/automation/instruction/contract"
import { failureFromSession, readProgress, runVerificationPath } from "../src/automation/instruction/runtime"

const app = {
  name: "整理订单",
  description: "只读报告",
  parameters: [{ key: "date", label: "日期", required: true, defaultValue: "" }],
  instructions: [{ id: "read", title: "读取订单", text: "读取指定日期的订单并整理报告" }],
}

describe("指令应用契约", () => {
  test("保留业务指令，并将运行参数作为数据传入", () => {
    const value = instructionDefinition(app)
    expect(value.instructions).toEqual(app.instructions)
    const prompt = instructionPrompt(value, { date: "2026-01-01" })
    expect(prompt).toContain('"date":"2026-01-01"')
    expect(prompt).toContain("执行结果不确定时暂停")
    expect(prompt).toContain("请求用户确认")
    expect(() => instructionPrompt(value, {})).toThrow()
    expect(() => instructionPrompt({ ...value, parameters: [{ key: "password", label: "密码", required: true, defaultValue: "" }] }, { password: "abc123" })).toThrow()
    expect(runVerificationPath("irun_123", "output/report.json")).toBe("output/automation/irun_123/output/report.json")
    expect(() => runVerificationPath("../bad", "output/report.json")).toThrow()
  })
  test("拒绝空指令、重复编号、非法参数和超长内容", () => {
    for (const patch of [
      { instructions: [] },
      { instructions: [...app.instructions, ...app.instructions] },
      { instructions: [{ id: "x", title: " ", text: "x" }] },
      { instructions: [{ id: "x", title: "x", text: "x".repeat(16385) }] },
      { instructions: [{ id: "../x", title: "x", text: "x" }] },
      { parameters: [{ key: "bad key", label: "x", required: false, defaultValue: "" }] },
    ])
      expect(() => instructionDefinition({ ...app, ...patch })).toThrow()
  })
  test("高风险指令可标记，秘密与非法校验路径被拒绝", () => {
    const guarded = instructionDefinition({
      ...app,
      instructions: [{ ...app.instructions[0]!, requiresConfirmation: true }],
      verification: { path: "output/report.json", contains: "total" },
    })
    expect(requiresConfirmation(guarded)).toBe(true)
    expect(verificationPath("output/report.json")).toBe(true)
    expect(verificationPath("../escape")).toBe(false)
    expect(() => instructionDefinition({ ...app, verification: { path: "/etc/passwd" } })).toThrow()
    expect(secretFinding({ ...app, instructions: [{ ...app.instructions[0]!, text: "密码：abcd1234" }] })).toContain("指令")
    expect(() => instructionDefinition({ ...app, instructions: [{ ...app.instructions[0]!, text: "password=abcd1234" }] })).toThrow()
    expect(() => instructionDefinition({ ...app, instructions: [{ ...app.instructions[0]!, text: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz" }] })).toThrow()
    expect(secretFinding(app)).toBeUndefined()
    expect(technicalInstructionFinding(app)).toBeUndefined()
    expect(
      technicalInstructionFinding({ ...app, instructions: [{ ...app.instructions[0]!, text: "使用 shell 运行 python3 抓取页面" }] }),
    ).toBeDefined()
    expect(instructionDefinition({ ...app, name: "Shell 商品汇总" }).name).toBe("Shell 商品汇总")
  })
  test("内容哈希随指令变化，用于绑定测试与发布", () => {
    const first = instructionDefinition(app)
    const second = instructionDefinition({ ...app, instructions: [{ ...app.instructions[0]!, text: "改为只读导出" }] })
    expect(contentHash(first)).not.toBe(contentHash(second))
    expect(contentHash(first)).toBe(contentHash({ ...first }))
  })
  test("会话整体失败时必须结束运行，且只归因本次之后的错误", () => {
    expect(failureFromSession([], "succeeded", 0)).toBeUndefined()
    expect(failureFromSession([], "failed", 0)).toEqual({ error: "会话执行失败", interrupted: false })
    expect(failureFromSession([{ error: { type: "provider.quota" }, time: { created: 5 } }], "failed", 10)).toMatchObject({ error: "会话执行失败" })
    expect(failureFromSession([{ error: { type: "provider.quota" }, time: { created: 15 } }], "failed", 10)?.error).toContain("provider.quota")
    expect(failureFromSession([], "interrupted", 0)).toEqual({ error: "执行被用户中断，未自动重试", interrupted: true })
  })
  test("按 promptMessageID 归属结果，失败与未完成分开处理", () => {
    const messages = [
      { type: "assistant", promptMessageID: "other", content: [{ type: "text", text: "别轮结果" }], time: { completed: 1 } },
      { type: "assistant", promptMessageID: "msg_1", content: [], time: { completed: 2 } },
    ]
    expect(readProgress(messages, "msg_2")).toEqual({ state: "pending" })
    expect(readProgress(messages, "msg_1")).toMatchObject({ state: "succeeded" })
    expect(readProgress([{ type: "assistant", promptMessageID: "msg_2", error: { message: "失败" } }], "msg_2"))
      .toMatchObject({ state: "failed" })
    // 看门狗/用户中止按“中断”处理，避免把外部中断当成应用缺陷去重新生成。
    expect(readProgress([{ type: "assistant", promptMessageID: "msg_2", error: { type: "aborted", message: "Step interrupted" } }], "msg_2"))
      .toMatchObject({ state: "failed", interrupted: true })
    expect(readProgress([{ type: "assistant", promptMessageID: "msg_2", content: [{ type: "text", text: "结果" }] }], "msg_2"))
      .toEqual({ state: "pending" })
    const toolTurn = [
      { type: "assistant", promptMessageID: "msg_3", finish: "tool-calls", content: [], time: { created: 2, completed: 2 } },
      { type: "assistant", promptMessageID: "msg_3", finish: "stop", content: [{ type: "text", text: "阶段结果" }], time: { created: 1, completed: 1 } },
    ]
    // 同一轮的工具调用消息不是最终结果，必须等待 stop 回合。
    expect(readProgress(toolTurn, "msg_3")).toEqual({ state: "pending" })
    expect(readProgress([
      { type: "assistant", promptMessageID: "msg_3", finish: "stop", content: [{ type: "text", text: "最终结果" }], time: { created: 3, completed: 3 } },
      ...toolTurn,
    ], "msg_3")).toEqual({ state: "succeeded", output: "最终结果" })
  })
})
