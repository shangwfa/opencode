export interface Agent {
  id: string
  sandboxId: string
  sessionId: string
  directory: string
  prompt: string
  title: string
  createdAt: string
  status: 'running' | 'idle' | 'error'
}

export interface MessagePart {
  id?: string
  type: string
  text?: string
  tool?: string
  state?: {
    status?: string
    input?: Record<string, unknown>
    output?: string
    title?: string
  }
}

export interface Message {
  info: {
    id: string
    role: string
    time?: { created?: number; completed?: number }
    finish?: string
  }
  parts: MessagePart[]
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error || `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

export const api = {
  listAgents: () => request<Agent[]>('/api/agents'),
  createAgent: (prompt: string, model?: { providerID: string; modelID: string }) =>
    request<Agent>('/api/agents', {
      method: 'POST',
      body: JSON.stringify({ prompt, ...(model ? { model } : {}) }),
    }),
  getAgent: (id: string) => request<Agent>(`/api/agents/${id}`),
  deleteAgent: (id: string) =>
    request<{ success: boolean }>(`/api/agents/${id}`, { method: 'DELETE' }),
  rebuildBrowser: (id: string) =>
    request<Agent>(`/api/agents/${id}/rebuild-browser`, { method: 'POST' }),
  abortAgent: (id: string) =>
    request<{ success: boolean }>(`/api/agents/${id}/abort`, { method: 'POST' }),
  getAgentStatus: (id: string) => request<{ busy: boolean }>(`/api/agents/${id}/status`),
  listMessages: (id: string) => request<Message[]>(`/api/agents/${id}/messages`),
  sendMessage: (id: string, text: string, model?: { providerID: string; modelID: string }) =>
    request<{ success: boolean }>(`/api/agents/${id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text, ...(model ? { model } : {}) }),
    }),
  listFiles: (id: string) => request<AgentFile[]>(`/api/agents/${id}/files`),
  readFile: (id: string, path: string) =>
    request<{ contentBase64: string; size: number }>(
      `/api/agents/${id}/files/content?path=${encodeURIComponent(path)}`,
    ),
  listModels: () =>
    request<{ models: ModelOption[]; current: { providerID: string; modelID: string } }>(
      '/api/models',
    ),
}

export interface AgentFile {
  path: string
  name: string
  size: number
  modifiedAt: number
}

export interface ModelOption {
  providerID: string
  modelID: string
  name: string
  label: string
}

const MODEL_KEY = 'cloud-browser:model'

export function getSavedModel(): { providerID: string; modelID: string } | null {
  const raw = localStorage.getItem(MODEL_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as { providerID: string; modelID: string }
  } catch {
    return null
  }
}

export function saveModel(model: { providerID: string; modelID: string }): void {
  localStorage.setItem(MODEL_KEY, JSON.stringify(model))
}
