import { Effect } from "effect"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "agent-local-registry" })

export interface AgentConnection {
  readonly id: string
  readonly workdir: string
  readonly send: (msg: unknown) => void
  readonly pending: Map<string, {
    resolve: (data: unknown) => void
    reject: (err: Error) => void
    onStream?: (data: unknown) => void
    onSettle?: () => void
  }>
  boundSessions: Set<string>
}

export interface RegistryInterface {
  readonly register: (workdir: string, send: (msg: unknown) => void) => AgentConnection
  readonly unregister: (agentID: string) => Effect.Effect<void>
  readonly bindSession: (sessionID: string, agentID: string) => Effect.Effect<void>
  readonly unbindSession: (sessionID: string) => Effect.Effect<void>
  readonly getForSession: (sessionID: string) => Effect.Effect<AgentConnection | null>
  readonly list: () => Array<{ agentID: string; workdir: string; boundSessions: string[] }>
}

const connections = new Map<string, AgentConnection>()
const sessionBindings = new Map<string, string>()

export const instance: RegistryInterface = {
  register: (workdir, send) => {
    const agentID = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const conn: AgentConnection = {
      id: agentID,
      workdir,
      send,
      pending: new Map(),
      boundSessions: new Set(),
    }
    connections.set(agentID, conn)
    log.info("agent registered", { agentID, workdir })
    return conn
  },

  unregister: (agentID) =>
    Effect.sync(() => {
      const conn = connections.get(agentID)
      if (conn) {
        for (const [, pending] of conn.pending) {
          pending.reject(new Error("Agent disconnected"))
        }
        for (const sid of conn.boundSessions) {
          sessionBindings.delete(sid)
        }
      }
      connections.delete(agentID)
      log.info("agent unregistered", { agentID })
    }),

  bindSession: (sessionID, agentID) =>
    Effect.sync(() => {
      const conn = connections.get(agentID)
      if (conn) {
        sessionBindings.set(sessionID, agentID)
        conn.boundSessions.add(sessionID)
      }
    }),

  unbindSession: (sessionID) =>
    Effect.sync(() => {
      const agentID = sessionBindings.get(sessionID)
      if (!agentID) return
      sessionBindings.delete(sessionID)
      connections.get(agentID)?.boundSessions.delete(sessionID)
    }),

  getForSession: (sessionID) =>
    Effect.sync(() => {
      const agentID = sessionBindings.get(sessionID)
      if (agentID) return connections.get(agentID) ?? null
      return null
    }),

  list: () =>
    Array.from(connections.values(), (conn) => ({
      agentID: conn.id,
      workdir: conn.workdir,
      boundSessions: Array.from(conn.boundSessions),
    })),
}

export * as AgentRegistry from "./registry"
