import { describe, expect, test } from "vitest"
import type { Message, Part } from "@/types/opencode"
import {
  computeCurrentTool,
  computeTurnPhase,
  resolvePhaseLabel,
  resolveStallHintText,
  STALL_RETRY_MS,
} from "./use-turn-phase"

const assistantMessage = {
  id: "msg_assistant",
  role: "assistant",
  time: { created: 1 },
} as Message

function runningToolPart(tool: string) {
  return {
    id: `prt_${tool}`,
    type: "tool",
    tool,
    state: { status: "running" },
  } as Part
}

// [MIGRATION] Solid 版经 createRoot + fakeTimers 驱动 hook；
// React 版的核心计算已抽为纯函数，这里对同一场景断言同样的结果
function withRunningTool(tool: string, elapsedMs: number) {
  const messages = [assistantMessage]
  const parts = { msg_assistant: [runningToolPart(tool)] }
  const phase = computeTurnPhase(true, messages, parts)
  const currentTool = computeCurrentTool(phase, messages, parts)
  return {
    phase,
    currentTool,
    phaseLabel: resolvePhaseLabel(phase, currentTool),
    stallHintText: resolveStallHintText(phase, currentTool, elapsedMs),
    showStallHint: elapsedMs >= 30_000,
    showStallRetry: elapsedMs >= STALL_RETRY_MS && !(currentTool === "task"),
  }
}

describe("useTurnPhase core", () => {
  test("labels a running task tool as sub-agent execution", () => {
    const r = withRunningTool("task", 0)
    expect(r.phase).toBe("tool_running")
    expect(r.currentTool).toBe("task")
    expect(r.phaseLabel).toBe("子代理执行中")
  })

  test("uses the sub-agent progress hint without enabling retry suggestions", () => {
    const r = withRunningTool("task", 181_000)
    expect(r.showStallHint).toBe(true)
    expect(r.stallHintText).toBe("子代理正在执行，可在上方查看进展")
    expect(r.showStallRetry).toBe(false)
  })

  test("keeps the existing tool-running copy and retry behavior for non-task tools", () => {
    const r = withRunningTool("shell", 181_000)
    expect(r.phaseLabel).toBe("工具执行中")
    expect(r.stallHintText).toBe("正在执行工具 shell，已等待 181 秒")
    expect(r.showStallRetry).toBe(true)
  })
})
