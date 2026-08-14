import { Effect } from "effect"
import { eq } from "drizzle-orm"
import * as Log from "@opencode-ai/core/util/log"
import { Database } from "../storage/db"

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
  readonly register: (workdir: string, send: (msg: unknown) => void, agentID?: string) => AgentConnection
  readonly unregister: (agentID: string) => Effect.Effect<void>
  readonly bindSession: (sessionID: string, agentID: string) => Effect.Effect<void>
  readonly unbindSession: (sessionID: string) => Effect.Effect<void>
  readonly getForSession: (sessionID: string) => Effect.Effect<AgentConnection | null>
  readonly list: () => Array<{ agentID: string; workdir: string; boundSessions: string[] }>
}

const connections = new Map<string, AgentConnection>()
const sessionBindings = new Map<string, string>()
// 负缓存：PG 确认无绑定的会话，避免远程会话每次工具调用都查 PG
const noBindingCache = new Set<string>()

const isPg = !!process.env["OPENCODE_DATABASE_URL"]

async function pgUpsertBinding(sessionID: string, agentID: string) {
  if (!isPg) return
  try {
    const { LocalAgentBindingTable } = await import("./binding.pg")
    const db = Database.Client() as any
    const now = Date.now()
    await db
      .insert(LocalAgentBindingTable)
      .values({ session_id: sessionID, agent_id: agentID, time_created: now, time_updated: now })
      .onConflictDoUpdate({
        target: LocalAgentBindingTable.session_id,
        set: { agent_id: agentID, time_updated: now },
      })
      .run()
  } catch (err) {
    log.warn("pg upsert binding failed", { sessionID, agentID, error: err instanceof Error ? err.message : String(err) })
  }
}

async function pgDeleteBinding(sessionID: string) {
  if (!isPg) return
  try {
    const { LocalAgentBindingTable } = await import("./binding.pg")
    const db = Database.Client() as any
    await db.delete(LocalAgentBindingTable).where(eq(LocalAgentBindingTable.session_id, sessionID)).run()
  } catch (err) {
    log.warn("pg delete binding failed", { sessionID, error: err instanceof Error ? err.message : String(err) })
  }
}

async function pgGetBinding(sessionID: string): Promise<string | null> {
  if (!isPg) return null
  try {
    const { LocalAgentBindingTable } = await import("./binding.pg")
    const db = Database.Client() as any
    const rows = await db
      .select({ agent_id: LocalAgentBindingTable.agent_id })
      .from(LocalAgentBindingTable)
      .where(eq(LocalAgentBindingTable.session_id, sessionID))
      .limit(1)
      .all()
    return rows[0]?.agent_id ?? null
  } catch (err) {
    log.warn("pg get binding failed", { sessionID, error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

async function pgListBindingsByAgent(agentID: string): Promise<string[]> {
  if (!isPg) return []
  try {
    const { LocalAgentBindingTable } = await import("./binding.pg")
    const db = Database.Client() as any
    const rows = await db
      .select({ session_id: LocalAgentBindingTable.session_id })
      .from(LocalAgentBindingTable)
      .where(eq(LocalAgentBindingTable.agent_id, agentID))
      .all()
    return rows.map((r: { session_id: string }) => r.session_id)
  } catch (err) {
    log.warn("pg list bindings failed", { agentID, error: err instanceof Error ? err.message : String(err) })
    return []
  }
}

export const instance: RegistryInterface = {
  register: (workdir, send, agentID) => {
    const id = agentID?.trim() || `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const conn: AgentConnection = {
      id,
      workdir,
      send,
      pending: new Map(),
      boundSessions: new Set(),
    }
    // 同 ID 重连（稳定 ID）：复用旧连接的绑定集合
    const prev = connections.get(id)
    if (prev) {
      for (const pending of prev.pending.values()) pending.reject(new Error("Agent reconnected"))
      conn.boundSessions = prev.boundSessions
    }
    connections.set(id, conn)
    for (const sid of conn.boundSessions) sessionBindings.set(sid, id)
    // SaaS 重启后内存清空：从 PG 恢复该 agent 的绑定（异步，不阻塞注册）
    if (isPg && conn.boundSessions.size === 0) {
      void pgListBindingsByAgent(id).then((sids) => {
        if (connections.get(id) !== conn) return
        for (const sid of sids) {
          conn.boundSessions.add(sid)
          sessionBindings.set(sid, id)
          noBindingCache.delete(sid)
        }
        if (sids.length > 0) log.info("bindings restored from pg", { agentID: id, count: sids.length })
      })
    }
    log.info("agent registered", { agentID: id, workdir, restoredBindings: conn.boundSessions.size })
    return conn
  },

  unregister: (agentID) =>
    Effect.sync(() => {
      const conn = connections.get(agentID)
      if (conn) {
        for (const [, pending] of conn.pending) {
          pending.reject(new Error("Agent disconnected"))
        }
        // 只清内存连接与缓存；PG 绑定保留——稳定 ID 重连后自动恢复
        for (const sid of conn.boundSessions) {
          if (sessionBindings.get(sid) === agentID) sessionBindings.delete(sid)
        }
      }
      connections.delete(agentID)
      log.info("agent unregistered", { agentID })
    }),

  bindSession: (sessionID, agentID) =>
    Effect.sync(() => {
      noBindingCache.delete(sessionID)
      const conn = connections.get(agentID)
      if (conn) {
        sessionBindings.set(sessionID, agentID)
        conn.boundSessions.add(sessionID)
      }
      void pgUpsertBinding(sessionID, agentID)
    }),

  unbindSession: (sessionID) =>
    Effect.sync(() => {
      const agentID = sessionBindings.get(sessionID)
      if (agentID) {
        sessionBindings.delete(sessionID)
        connections.get(agentID)?.boundSessions.delete(sessionID)
      }
      void pgDeleteBinding(sessionID)
    }),

  getForSession: (sessionID) =>
    Effect.gen(function* () {
      // 内存命中：连接在线且绑定有效
      const agentID = sessionBindings.get(sessionID)
      if (agentID) return connections.get(agentID) ?? null
      if (noBindingCache.has(sessionID)) return null

      // 内存 miss（进程重启/新实例）：查 PG，agent 在线则重建缓存
      const pgAgentID = yield* Effect.promise(() => pgGetBinding(sessionID))
      if (!pgAgentID) {
        if (isPg) noBindingCache.add(sessionID)
        return null
      }
      const conn = connections.get(pgAgentID)
      if (!conn) return null
      sessionBindings.set(sessionID, pgAgentID)
      conn.boundSessions.add(sessionID)
      log.info("binding restored from pg", { sessionID, agentID: pgAgentID })
      return conn
    }),

  list: () =>
    Array.from(connections.values(), (conn) => ({
      agentID: conn.id,
      workdir: conn.workdir,
      boundSessions: Array.from(conn.boundSessions),
    })),
}

export * as AgentRegistry from "./registry"
