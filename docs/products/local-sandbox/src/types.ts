export interface LocalAgentHealth {
  ok: boolean
  agentID: string | null
  workdir: string
  agentVersion: string
}

export interface SessionInfo {
  id: string
  title: string
  parentID: string | null
  directory: string
  timeCreated: number
  timeUpdated: number
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
    error?: string
    [k: string]: unknown
  }
}

export interface Message {
  info: {
    id: string
    sessionID?: string
    role: string
    time?: { created?: number; completed?: number }
    finish?: string
  }
  parts: MessagePart[]
}
