import type { Agent, TaskInfo, FilePreview, Message, ApiPart, ApiInfo, ApiMessage } from "./types"
import { AGENTS_VERSION, initialAgents } from "./constants"

export function loadStored<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

export function loadAgents(): Agent[] {
  const stored = loadStored<Agent[]>("session-team-agents", [])
  const version = Number(window.localStorage.getItem("session-team-agents-version") ?? "0")
  if (version >= AGENTS_VERSION) return stored
  const builtInNames = new Set(initialAgents.map((a) => a.name))
  const customs = stored.filter((a) => !builtInNames.has(a.name))
  window.localStorage.setItem("session-team-agents-version", String(AGENTS_VERSION))
  return [...initialAgents, ...customs]
}

export function isMessageFinished(value: string | boolean | undefined) {
  return value === true || value === "stop" || value === "error" || value === "abort" || value === "completed"
}

export function isInfoFinished(info: ApiInfo | undefined) {
  if (!info) return false
  return isMessageFinished(info.finish) || Boolean(info.error) || Boolean(info.time?.completed)
}

export function parseTaskInfo(part: ApiPart): TaskInfo | undefined {
  if (part.tool !== "task") return undefined
  return {
    description: part.state?.input?.description,
    subagent: part.state?.input?.subagent_type,
    status: part.state?.status,
    childId: part.state?.output?.match(/<task id="([^"]+)"/)?.[1],
  }
}

const fileContents = new Map<string, string>()

export function parseFileInfo(part: ApiPart): FilePreview | undefined {
  if (part.tool !== "write" && part.tool !== "edit") return undefined
  const filePath = part.state?.input?.filePath
  if (!filePath) return undefined
  if (part.tool === "write") {
    const content = part.state?.input?.content
    if (content) fileContents.set(filePath, content)
    return { filePath, content: content ?? fileContents.get(filePath) ?? "", status: part.state?.status }
  }
  const previous = fileContents.get(filePath) ?? ""
  const oldString = part.state?.input?.oldString
  const next =
    previous && oldString ? previous.replace(oldString, part.state?.input?.newString ?? "") : previous
  if (next !== previous) fileContents.set(filePath, next)
  return { filePath, content: next, status: part.state?.status }
}

export function toolLabel(part: ApiPart) {
  return `${part.tool ?? "tool"} · ${part.state?.status ?? "running"}${part.state?.error ? ` · ${part.state.error}` : ""}`
}

export function errorText(info: ApiInfo): string | undefined {
  const raw = info.error?.data?.message ?? info.error?.name
  if (!raw) return undefined
  return raw.replace(/^"+|"+$/g, "")
}

export function normalizeMessages(messages: ApiMessage[]): Message[] {
  return messages.flatMap<Message>((message, index) => {
    const info = message.info ?? {}
    const textParts = (message.parts ?? []).filter((part) => part.type === "text" && part.text)
    const reasoningParts = (message.parts ?? []).filter((part) => part.type === "reasoning" && part.text)
    const toolParts = (message.parts ?? []).filter((part) => part.type === "tool")
    const result: Message[] = []
    if ((textParts.length > 0 || reasoningParts.length > 0) && ["user", "assistant"].includes(info.role ?? ""))
      result.push({
        id: index + 1,
        sourceId: info.id,
        sourcePartId: textParts[0]?.id,
        reasoningPartId: reasoningParts[0]?.id,
        role: info.role as "user" | "assistant",
        agent: info.agent,
        text: textParts.map((part) => part.text).join("\n"),
        reasoning: reasoningParts.map((part) => part.text).join("\n") || undefined,
        time: "now",
        finish: isInfoFinished(info),
      })
    // 助手消息出错且无可见内容时，渲染错误卡片（否则用户完全无感知）
    const error = info.role === "assistant" ? errorText(info) : undefined
    if (error && textParts.length === 0 && reasoningParts.length === 0)
      result.push({
        id: (index + 1) * 1000 + 900,
        sourceId: info.id,
        role: "tool",
        agent: info.agent ?? "assistant",
        text: `执行失败 · ${error}`,
        error: true,
        time: "now",
      })
    toolParts.forEach((tool, toolIndex) => {
      const task = parseTaskInfo(tool)
      const file = parseFileInfo(tool)
      result.push({
        id: (index + 1) * 1000 + toolIndex + 1,
        sourceId: info.id,
        sourcePartId: tool.id,
        role: "tool",
        agent: info.agent ?? tool.tool ?? "task",
        text: task ? (task.description ?? toolLabel(tool)) : file ? file.filePath : toolLabel(tool),
        task,
        file,
        time: "now",
      })
    })
    return result
  })
}

export function mergeMessages(current: Message[], remote: Message[], optimisticId: number) {
  const optimistic = current.find((message) => message.id === optimisticId)
  return optimistic && remote.every((message) => message.text !== optimistic.text) ? [optimistic, ...remote] : remote
}
