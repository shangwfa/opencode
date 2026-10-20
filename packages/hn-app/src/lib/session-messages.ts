import type { Message, Part } from "@/types/opencode"

type Content = {
  type: string; id?: string; name?: string; text?: string
  time?: { created?: number; completed?: number }
  state?: { status?: string; input?: Record<string, unknown>; content?: { type: string; text?: string }[]; error?: unknown; metadata?: Record<string, unknown> }
}
export type SessionMessage = {
  id: string; type: string; text?: string; promptMessageID?: string; agent?: string
  model?: { id: string; providerID: string }; time: { created: number; completed?: number }
  content?: Content[]; outcome?: string
  error?: unknown
}

/** 把会话消息投影为时间线组件需要的消息和内容块。系统消息不进入聊天。 */
export function timelineMessages(sessionID: string, messages: SessionMessage[]): { info: Message; parts: Part[] }[] {
  let parentID = ""
  return messages.flatMap((message) => {
    if (message.type !== "user" && message.type !== "assistant") return []
    if (message.type === "user") parentID = message.id
    const model = message.model ?? { id: "", providerID: "" }
    const base = { id: message.id, sessionID, time: message.time, agent: message.agent ?? "build" }
    const info: Message = message.type === "user"
      ? { ...base, role: "user", model: { modelID: model.id, providerID: model.providerID } }
      : { ...base, role: "assistant", parentID: message.promptMessageID ?? parentID, modelID: model.id, providerID: model.providerID, error: message.error }
    // 仅剥离过去由平台追加的完整尾部提示，不修改历史存储或正文中的相同文字。
    const oldHint = "\n\n工作区 /workspace 已经由平台完成代码拉取与分支切换，请勿重复 git clone / git init；直接基于现有代码开发。"
    const text = message.text ?? ""
    const userText = text.endsWith(oldHint) ? text.slice(0, -oldHint.length) : text
    const content = message.type === "user" ? [{ type: "text", text: userText }] : message.content ?? []
    const ordinals = { text: 0, reasoning: 0 }
    const parts: Part[] = content.flatMap((item, index) => {
      const id = item.type === "text" || item.type === "reasoning"
        ? `${message.id}_${item.type}_${ordinals[item.type]++}` : `${message.id}_part_${index}`
      const part = { id, messageID: message.id, sessionID }
      if (item.type === "text") return [{ ...part, type: "text" as const, text: item.text ?? "" }]
      if (item.type === "reasoning") return [{ ...part, type: "reasoning" as const, text: item.text ?? "", time: { start: item.time?.created ?? message.time.created, end: item.time?.completed ?? message.time.completed } }]
      if (item.type === "tool") {
        const output = item.state?.content?.filter((entry) => entry.type === "text").map((entry) => entry.text ?? "").join("\n") ?? ""
        return [{ ...part, type: "tool" as const, tool: item.name ?? "tool", callID: item.id ?? part.id,
          state: { status: item.state?.status === "completed" ? "completed" : item.state?.status === "failed" ? "error" : "running", input: item.state?.input ?? {}, output, error: typeof item.state?.error === "string" ? item.state.error : undefined, metadata: item.state?.metadata, time: { start: item.time?.created ?? message.time.created, end: item.time?.completed } } } as Part]
      }
      return []
    })
    return [{ info, parts }]
  })
}
