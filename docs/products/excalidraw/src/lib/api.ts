export interface SessionRecord {
  id: string
  saasSessionId: string
  directory: string
  canvasId: string
  title: string
  createdAt: string
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

export interface ModelOption {
  providerID: string
  modelID: string
  name: string
  label: string
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
  listSessions: () => request<SessionRecord[]>('/api/sessions'),
  createSession: (prompt: string, model?: { providerID: string; modelID: string }) =>
    request<SessionRecord>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ prompt, model }),
    }),
  deleteSession: (id: string) =>
    request<{ success: boolean }>(`/api/sessions/${id}`, { method: 'DELETE' }),
  sendPrompt: (id: string, text: string, model?: { providerID: string; modelID: string }) =>
    request<{ success: boolean }>(`/api/sessions/${id}/prompt`, {
      method: 'POST',
      body: JSON.stringify({ text, model }),
    }),
  abortSession: (id: string) =>
    request<{ success: boolean }>(`/api/sessions/${id}/abort`, { method: 'POST' }),
  listMessages: (id: string) => request<Message[]>(`/api/sessions/${id}/messages`),
  listModels: () =>
    request<{ models: ModelOption[]; current: { providerID: string; modelID: string } }>('/api/models'),
}
