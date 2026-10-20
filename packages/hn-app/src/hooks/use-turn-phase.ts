/**
 * 会话窗口 turn 阶段机（React 版）。
 * 源：xybot-front-opencode-ui src/ui/hooks/use-turn-phase.ts
 * 纯核心（phase/currentTool/label/hint 计算）抽为函数 1:1 保留；
 * Solid 响应式（createMemo/createEffect/on + 1s 定时器）→ React useMemo/useEffect，语义一致。
 */
import { useEffect, useMemo, useRef, useState } from "react"
import type { Message, Part } from "@/types/opencode"

export type TurnPhase =
  | "idle"
  | "reasoning"
  | "text_streaming"
  | "tool_running"
  | "done"

export const STALL_HINT_MS = 30_000
export const STALL_RETRY_MS = 120_000

const PHASE_HINT_MS: Record<TurnPhase, number> = {
  idle: STALL_HINT_MS,
  reasoning: 60_000,
  text_streaming: 15_000,
  tool_running: 60_000,
  done: STALL_HINT_MS,
}

const PHASE_RETRY_MS: Record<TurnPhase, number> = {
  idle: STALL_RETRY_MS,
  reasoning: 180_000,
  text_streaming: 60_000,
  tool_running: 180_000,
  done: STALL_RETRY_MS,
}

/** [MIGRATION] 纯核心：由 messages/parts 计算当前 turn 阶段 */
export function computeTurnPhase(
  working: boolean,
  messages: Message[],
  parts: Record<string, Part[]>,
): TurnPhase {
  if (!working) return "idle"

  let latestAssistant: Message | undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      latestAssistant = messages[i]
      break
    }
  }
  if (!latestAssistant) return "reasoning"

  const msgParts = parts[latestAssistant.id] ?? []
  if (msgParts.length === 0) return "reasoning"

  for (const p of msgParts) {
    if (p.type === "tool" && p.state.status === "running") return "tool_running"
  }

  for (const p of msgParts) {
    if (p.type === "reasoning" && p.time && !p.time.end) return "reasoning"
  }

  const last = msgParts[msgParts.length - 1]
  if (last.type === "step-start" || last.type === "step-finish") return "reasoning"
  if (last.type === "text") return "text_streaming"

  return "reasoning"
}

/** [MIGRATION] 纯核心：正在运行的 tool 名（task → 子代理） */
export function computeCurrentTool(
  phase: TurnPhase,
  messages: Message[],
  parts: Record<string, Part[]>,
): string | null {
  if (phase !== "tool_running") return null
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "assistant") continue
    const msgParts = parts[messages[i].id] ?? []
    for (const p of msgParts) {
      if (p.type === "tool" && p.state.status === "running") return p.tool
    }
  }
  return null
}

/** 活动签名：内容/工具状态/部分数量任一变化即视为有新活动（源为 4 个 on() 追踪） */
function activitySignature(messages: Message[], parts: Record<string, Part[]>): string {
  let content = ""
  let state = ""
  let count = 0
  for (const msg of messages) {
    if (msg.role !== "assistant") continue
    const msgParts = parts[msg.id] ?? []
    count += msgParts.length
    for (const p of msgParts) {
      if (p.type === "text") content += p.text ?? ""
      if (p.type === "reasoning") content += p.text ?? ""
      if (p.type === "tool") state += p.tool + ":" + p.state.status + ","
    }
  }
  return `${content.length}|${state}|${count}`
}

export function resolvePhaseLabel(phase: TurnPhase, currentTool: string | null): string {
  switch (phase) {
    case "tool_running":
      if (currentTool === "task") return "子代理执行中"
      return "工具执行中"
    default:
      return "思考中"
  }
}

export function resolveStallHintText(
  phase: TurnPhase,
  currentTool: string | null,
  stalledMs: number,
): string {
  const secs = Math.floor(stalledMs / 1000)
  if (phase === "tool_running") {
    if (currentTool === "task") return "子代理正在执行，可在上方查看进展"
    const tool = currentTool ?? "工具"
    return `正在执行工具 ${tool}，已等待 ${secs} 秒`
  }
  if (phase === "reasoning") return `AI 正在深度思考，已等待 ${secs} 秒`
  if (phase === "text_streaming") return `模型生成中，已等待 ${secs} 秒`
  return `已等待 ${secs} 秒，响应有点慢，请稍候…`
}

export type TurnPhaseResult = {
  phase: TurnPhase
  phaseLabel: string
  stalledMs: number
  showStallHint: boolean
  showStallRetry: boolean
  currentTool: string | null
  stallHintText: string
}

export function useTurnPhase(input: {
  working: boolean
  messages: Message[]
  parts: Record<string, Part[]>
}): TurnPhaseResult {
  const { working, messages, parts } = input

  const phase = useMemo(() => computeTurnPhase(working, messages, parts), [working, messages, parts])
  const currentTool = useMemo(
    () => computeCurrentTool(phase, messages, parts),
    [phase, messages, parts],
  )
  const runningTaskTool = currentTool === "task"

  // 活动时间：阶段变化 / 内容·工具状态·数量签名变化 都会刷新（对齐源 4 个 on() 追踪）
  const signature = useMemo(() => activitySignature(messages, parts), [messages, parts])
  const [lastActivityAt, setLastActivityAt] = useState(Date.now())
  const lastActivityRef = useRef(lastActivityAt)

  useEffect(() => {
    setLastActivityAt(Date.now())
  }, [phase, signature])

  useEffect(() => {
    lastActivityRef.current = lastActivityAt
  }, [lastActivityAt])

  const [stalledMs, setStalledMs] = useState(0)

  useEffect(() => {
    if (!working) {
      setStalledMs(0)
      return
    }
    const tick = () => setStalledMs(Date.now() - lastActivityRef.current)
    tick()
    const interval = setInterval(tick, 1_000)
    return () => clearInterval(interval)
  }, [working, lastActivityAt])

  const showStallHint = stalledMs >= PHASE_HINT_MS[phase]
  const showStallRetry = !runningTaskTool && stalledMs >= PHASE_RETRY_MS[phase]

  return {
    phase,
    phaseLabel: resolvePhaseLabel(phase, currentTool),
    stalledMs,
    showStallHint,
    showStallRetry,
    currentTool,
    stallHintText: resolveStallHintText(phase, currentTool, stalledMs),
  }
}
