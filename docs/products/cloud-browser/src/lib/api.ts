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
  info: { id: string; role: string }
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
  createAgent: (prompt: string) =>
    request<Agent>('/api/agents', { method: 'POST', body: JSON.stringify({ prompt }) }),
  getAgent: (id: string) => request<Agent>(`/api/agents/${id}`),
  deleteAgent: (id: string) =>
    request<{ success: boolean }>(`/api/agents/${id}`, { method: 'DELETE' }),
  rebuildBrowser: (id: string) =>
    request<Agent>(`/api/agents/${id}/rebuild-browser`, { method: 'POST' }),
  listMessages: (id: string) => request<Message[]>(`/api/agents/${id}/messages`),
  sendMessage: (id: string, text: string) =>
    request<{ success: boolean }>(`/api/agents/${id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
}
