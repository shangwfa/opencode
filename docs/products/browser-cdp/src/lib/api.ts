export interface SessionEntry {
  id: string
  title: string
  timeUpdated: number | null
  sandbox: { image?: string } | null
}

export interface SessionStatus {
  sessionId: string
  sandboxId: string | null
  sandbox: { image?: string } | null
  ready: boolean
}

export interface Config {
  image: string
  saasBaseUrl: string
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
  }
}

export interface SessionMessage {
  info: {
    id: string
    role: string
    time?: { created?: number; completed?: number }
    finish?: string
  }
  parts: MessagePart[]
}
