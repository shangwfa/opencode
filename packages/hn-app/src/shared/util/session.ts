import { useEffect, useState } from "react"
import type { Message, Part } from "@/types/opencode"
import type { SessionStatus } from "@/types/opencode"

/**
 * 会话窗口的 turn 状态工具（自 xybot-front-opencode-ui src/shared/util/session.ts 移植）。
 * 纯函数 1:1；createEffectiveWorking（Solid 响应式）→ useEffectiveWorking（React），
 * 轮询语义保持：working 期间每 2s 重查一次最新 assistant turn 的 tool 状态。
 */

/**
 * 消息按创建时间排序的比较器：先比 time.created，相同则以 id 兜底。
 *
 * sync store 历史上按 id 字典序排序消息（依赖 ULID 单调递增），
 * 但 SaaS 后端分配的 msg_ 前缀跨周期后不再单调（如 08-13 的 `ffb...`
 * 字典序大于 08-17 的 `00d6...`），导致今天发的消息被排到会话顶部。
 * 改为按 time.created 排序后，时间戳相等时退回 id 序，保持与既有单测
 * （全部 time.created 相同、断言 id 序）一致。
 */
export function byMessageCreated(a: Message, b: Message): number {
  const ta = a.time?.created ?? 0
  const tb = b.time?.created ?? 0
  if (ta !== tb) return ta - tb
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * 判断一组 part 是否因为 tool 全部 error 而处于“卡住”状态。
 * 兜底场景：后端某个 tool 超时/报错后没有推 session.status: idle，
 * 前端看到所有 tool 都已经 terminal（error/completed）且至少有一个 error，
 * 就认为该 turn 不再处于“思考中”。
 */
export function isToolPartStalledByError(parts: Part[]): boolean {
  const toolParts = parts.filter((p): p is Extract<Part, { type: "tool" }> => p.type === "tool")
  if (toolParts.length === 0) return false

  const hasError = toolParts.some((p) => p.state.status === "error")
  const hasRunningOrPending = toolParts.some(
    (p) => p.state.status === "running" || p.state.status === "pending",
  )

  // 有 error 且没有还在跑的 tool，就认为卡住了
  return hasError && !hasRunningOrPending
}

/**
 * 判断当前（最近一次 user 消息之后的）assistant turn 是否因为 tool error 卡住。
 */
export function isLatestAssistantTurnStalledByToolError(
  messages: Message[],
  partsByMessage: Record<string, Part[]>,
): boolean {
  let latestUserIndex = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      latestUserIndex = i
      break
    }
  }

  for (let i = messages.length - 1; i > latestUserIndex; i--) {
    const message = messages[i]
    if (message.role !== "assistant") continue
    const parts = partsByMessage[message.id]
    if (!parts || parts.length === 0) continue
    return isToolPartStalledByError(parts)
  }

  return false
}

/**
 * [MIGRATION] 从最新 assistant turn 推导 working 覆写值（纯函数，便于测试）：
 * - 最新 assistant turn 的 tool 全 error 且无 running → false（卡住）
 * - 有正常 parts → true
 * - 无可判定 parts → null（回退默认）
 */
export function resolveEffectiveWorkingOverride(
  messages: Message[],
  parts: Record<string, Part[]>,
): boolean | null {
  let latestUserIndex = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      latestUserIndex = i
      break
    }
  }
  for (let i = messages.length - 1; i > latestUserIndex; i--) {
    const message = messages[i]
    if (message.role !== "assistant") continue
    const messageParts = parts[message.id]
    if (!messageParts || messageParts.length === 0) continue
    return !isToolPartStalledByError(messageParts)
  }
  return null
}

/**
 * 在原始 working 基础上增加 tool error 兜底：
 * 如果 session_status 显示 busy，但当前 turn 的 tool 全部 error 且没有 running，
 * 则把 effective working 视为 false。
 */
export function useEffectiveWorking(input: {
  working: boolean
  messages: Message[]
  parts: Record<string, Part[]>
}): boolean {
  const [override, setOverride] = useState<boolean | null>(null)

  useEffect(() => {
    if (!input.working) {
      setOverride(null)
      return
    }
    const check = () => setOverride(resolveEffectiveWorkingOverride(input.messages, input.parts))
    check()
    const interval = setInterval(check, 2000)
    return () => clearInterval(interval)
    // 输入以调用方轮询/订阅节奏变化，这里仅随 working 重置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input.working])

  if (!input.working) return false
  return override ?? true
}

export function shouldShowTurnThinking(input: {
  visualWorking: boolean
  hasError: boolean
  statusType: SessionStatus["type"]
}): boolean {
  if (!input.visualWorking) return false
  if (input.statusType === "retry") return false
  return true
}
