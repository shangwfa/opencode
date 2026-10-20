import { describe, expect, test } from "vitest"
import type { Message, Part } from "@/types/opencode"
import {
  isToolPartStalledByError,
  resolveEffectiveWorkingOverride,
  shouldShowTurnThinking,
} from "./session"

const userMessage = {
  id: "msg_user",
  role: "user",
  time: { created: 1 },
} as Message

const assistantMessage = {
  id: "msg_assistant",
  role: "assistant",
  parentID: "msg_user",
  time: { created: 2 },
} as Message

const toolPart = (status: "pending" | "running" | "completed" | "error") =>
  ({
    id: `prt_${status}`,
    type: "tool",
    tool: "webfetch",
    state: status === "error" ? { status, error: "StatusCode" } : { status },
  }) as Part

describe("isToolPartStalledByError", () => {
  test("treats errored tools with no pending work as stalled", () => {
    expect(isToolPartStalledByError([toolPart("error")])).toBe(true)
  })

  test("does not treat an errored tool as stalled while another tool is still running", () => {
    expect(isToolPartStalledByError([toolPart("error"), toolPart("running")])).toBe(false)
  })
})

// [MIGRATION] Solid 版经 createRoot 驱动 createEffectiveWorking（2s 轮询 hook），
// React 版把可测核心抽为 resolveEffectiveWorkingOverride 纯函数，hook 仅做定时重查
describe("resolveEffectiveWorkingOverride", () => {
  test("returns true (keep working) while the latest assistant tool is running", () => {
    expect(
      resolveEffectiveWorkingOverride([userMessage, assistantMessage], {
        msg_assistant: [toolPart("running")],
      }),
    ).toBe(true)
  })

  test("returns false when the latest assistant turn is stalled by tool errors", () => {
    expect(
      resolveEffectiveWorkingOverride([userMessage, assistantMessage], {
        msg_assistant: [toolPart("error")],
      }),
    ).toBe(false)
  })

  test("returns null when there is no judgeable assistant parts", () => {
    expect(resolveEffectiveWorkingOverride([userMessage, assistantMessage], {})).toBe(null)
  })
})

describe("shouldShowTurnThinking", () => {
  test("keeps the visual thinking indicator visible while a busy turn reports an error", () => {
    expect(
      shouldShowTurnThinking({
        visualWorking: true,
        hasError: true,
        statusType: "busy",
      }),
    ).toBe(true)
  })

  test("keeps the visual thinking indicator visible while later content streams in", () => {
    expect(
      shouldShowTurnThinking({
        visualWorking: true,
        hasError: false,
        statusType: "busy",
      }),
    ).toBe(true)
  })

  test("hides the visual thinking indicator once the session is idle", () => {
    expect(
      shouldShowTurnThinking({
        visualWorking: false,
        hasError: false,
        statusType: "idle",
      }),
    ).toBe(false)
  })

  test("keeps retry status on the retry UI instead of the ordinary thinking indicator", () => {
    expect(
      shouldShowTurnThinking({
        visualWorking: true,
        hasError: false,
        statusType: "retry",
      }),
    ).toBe(false)
  })
})
