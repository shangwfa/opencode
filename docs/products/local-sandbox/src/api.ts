import type { LocalAgentHealth, Message, SessionInfo } from "./types"

const LOCAL_AGENT_URL = "http://localhost:17790"
const SAAS_KEY = "local-sandbox:saas-base"

export function getSaasBase(): string {
  return localStorage.getItem(SAAS_KEY) ?? "http://localhost:14096"
}

export function setSaasBase(url: string) {
  localStorage.setItem(SAAS_KEY, url.replace(/\/+$/, ""))
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${getSaasBase()}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`)
  }
  return res.json() as Promise<T>
}

// ── 本地 Agent（浏览器直连 localhost:17790，Agent 已开 CORS） ──

export async function detectLocalAgent(): Promise<LocalAgentHealth | null> {
  try {
    const res = await fetch(`${LOCAL_AGENT_URL}/health`, { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return null
    return (await res.json()) as LocalAgentHealth
  } catch {
    return null
  }
}

// ── SaaS：本地 Agent 绑定 ─────────────────────────────────────

export async function listAgents(): Promise<Array<{ agentID: string; workdir: string; boundSessions?: string[] }>> {
  const data = await request<{ agents: Array<{ agentID: string; workdir: string; boundSessions?: string[] }> }>("/local-agents")
  return data.agents ?? []
}

export async function bindLocalAgent(sessionID: string, agentID: string): Promise<void> {
  await request(`/session/${sessionID}/local-agent`, {
    method: "POST",
    body: JSON.stringify({ agentID }),
  })
}

export async function unbindLocalAgent(sessionID: string): Promise<void> {
  await request(`/session/${sessionID}/local-agent`, { method: "DELETE" })
}

// ── SaaS：会话 ────────────────────────────────────────────────

interface RawSession {
  id?: string
  title?: string
  parentID?: string | null
  directory?: string
  time?: { created?: number; updated?: number; archived?: number }
  timeCreated?: number
  timeUpdated?: number
}

function mapSession(s: RawSession): SessionInfo {
  return {
    id: s.id ?? "",
    title: s.title || "Untitled",
    parentID: s.parentID ?? null,
    directory: s.directory ?? "",
    timeCreated: s.time?.created ?? s.timeCreated ?? 0,
    timeUpdated: s.time?.updated ?? s.timeUpdated ?? 0,
  }
}

export async function listSessions(): Promise<SessionInfo[]> {
  const data = await request<RawSession[]>("/session")
  return (Array.isArray(data) ? data : []).map(mapSession)
}

export async function createSession(title: string): Promise<SessionInfo> {
  const s = await request<RawSession>("/session", {
    method: "POST",
    body: JSON.stringify({ title }),
  })
  return mapSession(s)
}

export async function deleteSession(sessionID: string): Promise<void> {
  await request(`/session/${sessionID}`, { method: "DELETE" })
}

// ── SaaS：消息 ────────────────────────────────────────────────

export async function listMessages(sessionID: string): Promise<Message[]> {
  const data = await request<Partial<Message>[]>(`/session/${sessionID}/message`)
  return (Array.isArray(data) ? data : []).map((m) => ({
    info: {
      id: m.info?.id ?? "",
      sessionID: m.info?.sessionID,
      role: m.info?.role ?? "assistant",
      time: m.info?.time,
      finish: m.info?.finish,
    },
    parts: m.parts ?? [],
  }))
}

export interface ModelRef {
  providerID: string
  modelID: string
}

export async function sendMessage(sessionID: string, text: string, model?: ModelRef): Promise<void> {
  await request(`/session/${sessionID}/message`, {
    method: "POST",
    body: JSON.stringify({
      agent: "build",
      parts: [{ type: "text", text }],
      ...(model ? { model } : {}),
    }),
  })
}

export async function abortSession(sessionID: string): Promise<void> {
  await request(`/session/${sessionID}/abort`, { method: "POST" })
}

// ── SaaS：SSE 事件流 ──────────────────────────────────────────

export interface SaasEvent {
  type: string
  properties?: {
    sessionID?: string
    info?: { id: string; sessionID: string; role: string }
    part?: { sessionID: string; messageID: string; part: { type: string; [k: string]: unknown } }
    [k: string]: unknown
  }
}

export function openEventStream(onEvent: (ev: SaasEvent) => void): EventSource {
  const es = new EventSource(`${getSaasBase()}/event`)
  es.onmessage = (e) => {
    try {
      onEvent(JSON.parse(e.data) as SaasEvent)
    } catch {
      // ignore malformed events
    }
  }
  return es
}
