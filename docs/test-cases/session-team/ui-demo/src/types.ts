export type AgentMode = "primary" | "subagent"
export type View = "session" | "team" | "members"

export type Agent = {
  name: string
  label: string
  mode: AgentMode
  provider: string
  model: string
  tone: string
  permissions: string[]
  status: "ready" | "running"
}

export type TaskInfo = {
  description?: string
  subagent?: string
  status?: string
  childId?: string
}

export type FilePreview = {
  filePath: string
  content: string
  status?: string
}

export type Message = {
  id: number
  sourceId?: string
  sourcePartId?: string
  reasoningPartId?: string
  role: "user" | "assistant" | "tool"
  agent?: string
  text: string
  reasoning?: string
  time: string
  finish?: boolean
  task?: TaskInfo
  file?: FilePreview
  pending?: boolean
  error?: boolean
}

export type QueuedMessage = {
  id: number
  bubbleId: number
  text: string
  agent: string
}

export type ApiPart = {
  id?: string
  messageID?: string
  type?: string
  text?: string
  tool?: string
  state?: {
    status?: string
    error?: string
    input?: {
      description?: string
      prompt?: string
      subagent_type?: string
      command?: string
      filePath?: string
      content?: string
      oldString?: string
      newString?: string
    }
    output?: string
  }
}

export type ApiInfo = {
  id?: string
  role?: string
  agent?: string
  finish?: string | boolean
  error?: { name?: string; data?: { message?: string } }
  time?: { created?: number; completed?: number }
}

export type ApiMessage = {
  info?: ApiInfo
  parts?: ApiPart[]
}

export type StreamEvent = {
  type?: string
  properties?: {
    sessionID?: string
    messageID?: string
    partID?: string
    field?: string
    delta?: string
    status?: { type?: string }
  }
}

export type ApiSession = { id: string; directory?: string; title?: string }

export type Member = {
  name: string
  label: string
  title: string
}

export type ModelRef = {
  providerID: string
  modelID: string
}

export type ModelOption = ModelRef & {
  providerName: string
  modelName: string
}

export type SessionEntry = {
  id: string
  title: string
  directory?: string
  createdAt: number
  titled?: boolean
}

export type QuestionOption = { label: string; description?: string }

export type QuestionInfo = {
  question: string
  header?: string
  options: QuestionOption[]
  multiple?: boolean
  custom?: boolean
}

export type QuestionRequest = {
  id: string
  sessionID: string
  questions: QuestionInfo[]
}

export type PermissionRequest = {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  metadata?: { command?: string; description?: string }
  always?: string[]
  tool?: { messageID?: string; callID?: string }
}
