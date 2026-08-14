import { Effect } from "effect"
import { eq } from "drizzle-orm"
import * as Log from "@opencode-ai/core/util/log"
import { Database } from "../storage/db"

const log = Log.create({ service: "agent-local-registry" })

export interface AgentConnection {
  readonly id: string
  readonly workdir: string
  readonly send: (msg: unknown) => void
  // 由 ws 层注入：registry 替换同 ID 连接时主动关闭旧 ws（防幽灵 Agent）
  close?: () => void
  readonly pending: Map<string, {
    resolve: (data: unknown) => void
    reject: (err: Error) => void
    onStream?: (data: unknown) => void
  }>
  boundSessions: Set<string>
}

export interface RegistryInterface {
  readonly register: (workdir: string, send: (msg: unknown) => void, agentID?: string) => AgentConnection
  readonly unregister: (agentID: string, owner?: AgentConnection) => Effect.Effect<void>
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

// 按 sessionID 串行化 PG 写入：防 bind→unbind 并发时 upsert/delete 落库乱序产生幽灵绑定
const pgWriteChains = new Map<string, Promise<void>>()

function serializePgWrite(sessionID: string, op: () => Promise<void>): Promise<void> {
  const prev = pgWriteChains.get(sessionID) ?? Promise.resolve()
  const next = prev.then(op).catch(() => undefined).finally(() => {
    if (pgWriteChains.get(sessionID) === next) pgWriteChains.delete(sessionID)
  })
  pgWriteChains.set(sessionID, next)
  return next
}

async function pgUpsertBinding(sessionID: string, agentID: string) {
  if (!isPg) return
  await serializePgWrite(sessionID, async () => {
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
  })
}

async function pgDeleteBinding(sessionID: string) {
  if (!isPg) return
  await serializePgWrite(sessionID, async () => {
    try {
      const { LocalAgentBindingTable } = await import("./binding.pg")
      const db = Database.Client() as any
      await db.delete(LocalAgentBindingTable).where(eq(LocalAgentBindingTable.session_id, sessionID)).run()
    } catch (err) {
      log.warn("pg delete binding failed", { sessionID, error: err instanceof Error ? err.message : String(err) })
    }
  })
}

// PG 查询结果：undefined = 查询失败（不可当"无绑定"缓存），null = 确认无绑定
async function pgGetBinding(sessionID: string): Promise<string | null | undefined> {
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
    return undefined
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
      // 服务端主动关闭被替换的旧 ws：否则旧连接成幽灵（进程活着、ws 挂着，
      // 但已除名，不会自动恢复），其 close 回调因 owner 校验不会误删新连接
      prev.close?.()
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

  unregister: (agentID, owner) =>
    Effect.sync(() => {
      const conn = connections.get(agentID)
      // 属主校验：同稳定 ID 重连后旧连接被覆盖，僵死旧连接的 close
      // 不得注销当前在线的新连接（否则误杀在途请求并回退远程沙箱）
      if (!conn || (owner && conn !== owner)) return
      for (const [, pending] of conn.pending) {
        pending.reject(new Error("Agent disconnected"))
      }
      // 只清内存连接与缓存；PG 绑定保留——稳定 ID 重连后自动恢复
      for (const sid of conn.boundSessions) {
        if (sessionBindings.get(sid) === agentID) sessionBindings.delete(sid)
      }
      connections.delete(agentID)
      log.info("agent unregistered", { agentID })
    }),

  bindSession: (sessionID, agentID) =>
    Effect.sync(() => {
      noBindingCache.delete(sessionID)
      // 改绑时原子移除旧 owner 的残留：否则旧 Agent 的 boundSessions 仍含该
      // 会话，其重连/被抢占替换时会把路由写回旧 owner（绑定漂移）
      const prevID = sessionBindings.get(sessionID)
      if (prevID && prevID !== agentID) connections.get(prevID)?.boundSessions.delete(sessionID)
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
      // PG 查询失败：按无绑定处理但不写负缓存（区分 NotFound 与暂时性错误，
      // 否则一次数据库抖动会让该会话永远 fallback 远程）
      if (pgAgentID === undefined) return null
      if (pgAgentID === null) {
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
