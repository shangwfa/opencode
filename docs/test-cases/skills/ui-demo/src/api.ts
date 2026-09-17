// ── OpenCode SaaS API 客户端（经 Vite proxy /opencode → localhost:14096）──

export const MODEL = { providerID: "zhipuai", modelID: "glm-5.1" }

const BASE = "/opencode"

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`)
  }
  // prompt_async / DELETE 等返回 204 空 body
  if (res.status === 204 || res.headers.get("content-length") === "0") {
    return undefined as T
  }
  return res.json()
}

export interface Session {
  id: string
  title?: string
  time?: { created?: number; updated?: number }
}

export interface SessionSkillResource {
  path: string
  type: "doc" | "script" | "template" | "asset"
  size: number
  digest: string
}

export interface SessionSkill {
  name: string
  description?: string
  location: string
  content: string
  resources?: SessionSkillResource[]
}

export interface SkillBundleInput {
  name: string
  description: string
  content: string
  resources: { path: string; type: string; content: string }[]
}

export interface MessagePart {
  id?: string
  type: string
  text?: string
  tool?: string
  state?: {
    status?: string
    input?: unknown
    output?: string
    title?: string
    error?: string
  }
}

export interface Message {
  id: string
  role: string
  parts: MessagePart[]
  info?: { id?: string; role?: string; time?: { created?: number } }
  time?: { created?: number }
}

export function messageRole(msg: Message): string {
  return msg.role ?? msg.info?.role ?? "?"
}

export interface ProviderInfo {
  id: string
  name: string
  models: Record<string, { id: string; name?: string }>
}

export interface ProvidersResponse {
  all: ProviderInfo[]
  default: Record<string, string>
  connected: string[]
}

export interface ModelRef {
  providerID: string
  modelID: string
}

// ── Provider ──

export const listProviders = () => request<ProvidersResponse>("/provider")

// ── Session ──

export const listSessions = () => request<Session[]>("/session")

export const createSession = (title?: string) =>
  request<Session>("/session", { method: "POST", body: JSON.stringify(title ? { title } : {}) })

export const deleteSession = (sessionId: string) =>
  request<void>(`/session/${sessionId}`, { method: "DELETE" })

// ── Session Skills ──

export const listSessionSkills = (sessionId: string) =>
  request<SessionSkill[]>(`/session/${sessionId}/skills`)

export const registerSkill = (sessionId: string, bundle: SkillBundleInput) =>
  request<SessionSkill>(`/session/${sessionId}/skills/create`, {
    method: "POST",
    body: JSON.stringify(bundle),
  })

export const unregisterSkill = (sessionId: string, name: string) =>
  request<void>(`/session/${sessionId}/skills/${encodeURIComponent(name)}`, { method: "DELETE" })

// ── Message ──

export const sendMessageAsync = (
  sessionId: string,
  text: string,
  opts: { skills?: string[]; model?: { providerID: string; modelID: string } },
) =>
  request<void>(`/session/${sessionId}/prompt_async`, {
    method: "POST",
    body: JSON.stringify({
      parts: [{ type: "text", text }],
      skills: opts.skills?.length ? opts.skills : undefined,
      model: opts.model ?? MODEL,
    }),
  })

export const listMessages = (sessionId: string) =>
  request<Message[]>(`/session/${sessionId}/message`)

export interface ExecResult {
  stdout?: string
  stderr?: string
  exitCode?: number
}

export const execInSandbox = (sessionId: string, command: string) =>
  request<ExecResult>(`/session/${sessionId}/exec`, {
    method: "POST",
    body: JSON.stringify({ command }),
  })

/** 读取沙箱中的文本文件内容 */
export const readSandboxFile = async (sessionId: string, filePath: string) => {
  // 确保路径以 /workspace 开头（沙箱工作区）
  const absPath = filePath.startsWith("/") ? filePath : `/workspace/${filePath}`
  const result = await execInSandbox(sessionId, `cat "${absPath}"`)
  if (result.exitCode !== 0 && !result.stdout) {
    throw new Error(result.stderr || `Failed to read ${absPath}`)
  }
  return result.stdout ?? ""
}

// ── Question ──

export interface QuestionOption {
  label: string
  description: string
}

export interface QuestionInfo {
  question: string
  header: string
  options: QuestionOption[]
  multiple?: boolean
  custom?: boolean
}

export interface QuestionRequest {
  id: string
  sessionID: string
  questions: QuestionInfo[]
}

export const listQuestions = () => request<QuestionRequest[]>("/question")

export const replyQuestion = (requestID: string, answers: string[][]) =>
  request<boolean>(`/question/${requestID}/reply`, {
    method: "POST",
    body: JSON.stringify({ answers }),
  })

export const rejectQuestion = (requestID: string) =>
  request<boolean>(`/question/${requestID}/reject`, { method: "POST" })

// ── 本地技能目录（Vite middleware）──

export interface CatalogEntry {
  key: string
  name: string
  description: string
  resourceCount: number
  totalBytes: number
  bundle: string
}

export const fetchSkillsCatalog = () =>
  fetch("/api/skills/catalog").then((r) => r.json() as Promise<CatalogEntry[]>)

export const fetchSkillBundle = (key: string) =>
  fetch(`/api/skills/bundle/${encodeURIComponent(key)}`).then(async (r) => {
    if (!r.ok) throw new Error(await r.text())
    return r.json() as Promise<SkillBundleInput>
  })
