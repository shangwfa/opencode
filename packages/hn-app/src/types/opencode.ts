/**
 * OpenCode REST API 类型（自有定义，去 SDK 化）。
 * 形状对齐 opencode v2 API（Message / Part / SessionStatus / FileContent / VcsFileDiff），
 * 由 REST JSON 直接断言使用；服务端新增 part 类型时在此补成员。
 */

// ── 基础 ──

export type PartBase = {
  id: string
  sessionID: string
  messageID: string
}

// ── Part 联合 ──

export type TextPart = PartBase & {
  type: "text"
  text: string
  synthetic?: boolean
  ignored?: boolean
  time?: {
    start: number
    end?: number
  }
  metadata?: Record<string, unknown>
}

export type ReasoningPart = PartBase & {
  type: "reasoning"
  text: string
  metadata?: Record<string, unknown>
  time?: {
    start: number
    end?: number
  }
}

export type ToolStateStatus = "pending" | "running" | "completed" | "error"

export type ToolPart = PartBase & {
  type: "tool"
  callID?: string
  tool: string
  state: {
    status: ToolStateStatus
    input?: Record<string, unknown>
    output?: unknown
    error?: unknown
    metadata?: Record<string, unknown>
    title?: string
  }
  time?: {
    start: number
    end?: number
  }
  metadata?: Record<string, unknown>
}

export type StepStartPart = PartBase & {
  type: "step-start"
  snapshot?: string
}

export type StepFinishPart = PartBase & {
  type: "step-finish"
  reason?: string
  snapshot?: string
  cost?: number
  tokens?: {
    total?: number
    input: number
    output: number
    reasoning: number
    cache: {
      read: number
      write: number
    }
  }
}

export type FilePart = PartBase & {
  type: "file"
  mime: string
  filename?: string
  url: string
  source?: {
    type: "file"
    path: string
    text?: {
      value: string
      start: number
      end: number
    }
    [key: string]: unknown
  }
}

export type SnapshotPart = PartBase & {
  type: "snapshot"
  snapshot: string
}

export type AgentPart = PartBase & {
  type: "agent"
  name: string
  source?: {
    value: string
    start: number
    end: number
  }
}

export type PatchPart = PartBase & {
  type: "patch"
  hash: string
  files: string[]
}

export type SubtaskPart = PartBase & {
  type: "subtask"
  prompt: string
  description?: string
  agent: string
}

export type RetryPart = PartBase & {
  type: "retry"
  attempt: number
  providerID?: string
  modelID?: string
}

export type CompactionPart = PartBase & {
  type: "compaction"
  auto?: boolean
}

export type Part =
  | TextPart
  | ReasoningPart
  | ToolPart
  | StepStartPart
  | StepFinishPart
  | FilePart
  | SnapshotPart
  | AgentPart
  | PatchPart
  | SubtaskPart
  | RetryPart
  | CompactionPart

// ── Message ──

export type MessageBase = {
  id: string
  sessionID: string
  time: {
    created: number
    completed?: number
  }
}

export type UserMessage = MessageBase & {
  role: "user"
  agent: string
  model: {
    providerID: string
    modelID: string
    variant?: string
  }
  system?: string
  tools?: Record<string, boolean>
  userName?: string
  userId?: string
}

export type AssistantMessage = MessageBase & {
  role: "assistant"
  parentID: string
  agent: string
  modelID: string
  providerID: string
  mode?: string
  path?: {
    cwd: string
    root: string
  }
  summary?: boolean
  cost?: number
  tokens?: StepFinishPart["tokens"]
  error?: unknown
}

export type Message = UserMessage | AssistantMessage

export function isUserMessage(m: Message): m is UserMessage {
  return m.role === "user"
}

export function isAssistantMessage(m: Message): m is AssistantMessage {
  return m.role === "assistant"
}

// ── 会话状态 ──

export type SessionStatus =
  | { type: "idle" }
  | {
      type: "retry"
      attempt: number
      message: string
      next: number
      action?: {
        reason: string
        provider: string
        title: string
        message: string
        label: string
        link?: string
      }
    }
  | { type: "busy" }

// ── 文件内容 ──

export type FileContent = {
  type: "text" | "binary"
  content: string
  diff?: string
  encoding?: "base64"
  mimeType?: string
}

// ── VCS diff ──

export type VcsFileDiff = {
  file: string
  patch?: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
}

// ── Provider / Model ──

export type ProviderModel = {
  id: string
  name?: string
  [key: string]: unknown
}

export type ProviderListResponse = {
  connected?: string[]
  all?: {
    id: string
    models?: Record<string, ProviderModel>
    [key: string]: unknown
  }[]
  [key: string]: unknown
}

// ── 文件树节点 ──

export type FileNode = {
  name: string
  path: string
  absolute: string
  type: "file" | "directory"
  ignored: boolean
}

// ── 请求 part 输入（prompt_async / command 的 parts） ──

export type TextPartInput = {
  id?: string
  type: "text"
  text: string
  synthetic?: boolean
  ignored?: boolean
  time?: {
    start: number
    end?: number
  }
  metadata?: Record<string, unknown>
}

export type AgentPartInput = {
  id?: string
  type: "agent"
  name: string
  source?: {
    value: string
    start: number
    end: number
  }
}

export type FilePartInput = {
  id?: string
  type: "file"
  mime: string
  filename?: string
  url: string
  source?: {
    type: "file"
    path: string
    text?: {
      value: string
      start: number
      end: number
    }
    [key: string]: unknown
  }
}

export type PartInput = TextPartInput | AgentPartInput | FilePartInput

// ── 事件 ──

export type Event = {
  type: string
  properties: Record<string, unknown>
}
