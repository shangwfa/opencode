/**
 * 会话数据源：根据是否启用 hn-base-server 切换「直连 SaaS」与「经 base-server」。
 *
 *  - 未配置 VITE_HN_BASE_URL → 直连（现状，全部请求走 lib/rest.ts）
 *  - 已配置 → 会话列表/创建/发送/中止/消息/事件流走 base-server（带归属校验）
 */
import { authEnabled } from "./auth"
import { baseFetch } from "./base-api"
import { subscribeSessionEvents } from "./base-sse"
import { timelineMessages, type SessionMessage } from "./session-messages"

export type ChatSession = {
  id: string
  title?: string | null
  parentID?: string | null
  directory?: string
  time?: { created?: number; updated?: number }
  [key: string]: unknown
}

export type SessionSource = {
  /** 我的会话列表 */
  list(): Promise<ChatSession[]>
  /** 创建会话（返回含 id） */
  create(input: { title?: string; directory?: string }): Promise<ChatSession>
  /** 发送消息（SaaS prompt_async 语义） */
  sendMessage(sessionId: string, body: Record<string, unknown>): Promise<unknown>
  /** 中止 */
  abort(sessionId: string): Promise<unknown>
  /** 消息列表（[{info|message, parts}]） */
  messages(sessionId: string): Promise<unknown[]>
  /** 单会话事件流（SSE）；onEnd 在断开时触发（供重连）；返回取消函数 */
  subscribe(
    sessionId: string,
    onEvent: (e: { type: string; properties: Record<string, unknown> }) => void,
    onEnd?: () => void,
  ): () => void
}

/** 直连 SaaS（现状）：沿用 lib/rest.ts */
const saasSource: SessionSource = {
  async list() {
    const { sessionList } = await import("./rest")
    return (await sessionList()) as ChatSession[]
  },
  async create(input) {
    const { sessionCreate } = await import("./rest")
    const created = await sessionCreate({ body: input.title ? { title: input.title } : {} })
    return created as ChatSession
  },
  async sendMessage(sessionId, body) {
    const { sessionPromptAsync } = await import("./rest")
    return sessionPromptAsync(sessionId, body)
  },
  async abort(sessionId) {
    const { sessionAbort } = await import("./rest")
    return sessionAbort(sessionId)
  },
  async messages(sessionId) {
    const { sessionMessages } = await import("./rest")
    const res = await sessionMessages(sessionId)
    return ((res.data ?? res) as unknown[]) ?? []
  },
  subscribe() {
    // 直连模式的事件流由 DataProvider 的全局订阅负责，这里不需要
    return () => {}
  },
}

/** 经 hn-base-server（带 Bearer 与归属校验） */
const baseSource: SessionSource = {
  async list() {
    const res = await baseFetch<{ items: ChatSession[] }>("/api/sessions")
    return res.items ?? []
  },
  async create(input) {
    const res = await baseFetch<{ session: ChatSession }>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ ...(input.title ? { title: input.title } : {}), directory: input.directory }),
    })
    return res.session
  },
  async sendMessage(sessionId, body) {
    return baseFetch<unknown>(`/api/sessions/${encodeURIComponent(sessionId)}/message`, {
      method: "POST",
      body: JSON.stringify(body),
    })
  },
  async abort(sessionId) {
    return baseFetch<unknown>(`/api/sessions/${encodeURIComponent(sessionId)}/abort`, { method: "POST" })
  },
  async messages(sessionId) {
    const res = await baseFetch<{ data?: SessionMessage[] }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
    )
    return timelineMessages(sessionId, res.data ?? [])
  },
  subscribe(sessionId, onEvent, onEnd) {
    return subscribeSessionEvents(sessionId, onEvent, onEnd)
  },
}

export function sessionSource(): SessionSource {
  return authEnabled ? baseSource : saasSource
}

export function usingBaseServer(): boolean {
  return authEnabled
}
