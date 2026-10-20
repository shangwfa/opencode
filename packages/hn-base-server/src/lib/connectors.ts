/**
 * 用户级连接器作用域。
 *
 * Connector 服务按会话资源域保存连接，这里为每个用户维护一个隐藏会话，
 * 让全局连接器板块有稳定的归属；会话不写入 relation_tuple，因此不会出现在会话列表。
 */
import { eq } from "drizzle-orm"
import { db } from "../db/index.js"
import { connectorScope } from "../db/schema.js"
import { saasCreateSession, saasFetch } from "./saas.js"
import { errors } from "./errors.js"

const inflight = new Map<string, Promise<string>>()

async function createScope(userId: string): Promise<string> {
  // 引擎未启用时不要先创建一个永远无法使用的隐藏会话。
  const probe = await saasFetch("/api/connector/categories")
  if (!probe.ok) {
    const text = await probe.text().catch(() => "")
    let message = text.slice(0, 200)
    try { message = (JSON.parse(text) as { message?: string }).message ?? message } catch {}
    if (probe.status === 503) throw errors.upstream(503, message || "连接器服务未启用")
    throw errors.upstream(502, message || `连接器服务返回 ${probe.status}`)
  }
  const sessionId = await saasCreateSession({ directory: "/workspace", title: "连接器空间", agent: "build" })
  const now = Date.now()
  try {
    await db.insert(connectorScope).values({ userId, sessionId, timeCreated: now, timeUpdated: now })
    return sessionId
  } catch {
    const [existing] = await db.select().from(connectorScope).where(eq(connectorScope.userId, userId)).limit(1)
    // 并发首建或落库失败：丢弃本次孤儿会话。
    await saasFetch(`/api/session/${encodeURIComponent(sessionId)}`, { method: "DELETE" }).catch(() => undefined)
    if (existing) return existing.sessionId
    throw errors.internal("创建连接器空间失败")
  }
}

export async function connectorSession(userId: string, options?: { create?: boolean }): Promise<string | null> {
  const [row] = await db.select().from(connectorScope).where(eq(connectorScope.userId, userId)).limit(1)
  if (row) {
    const response = await saasFetch(`/api/session/${encodeURIComponent(row.sessionId)}`).catch(() => undefined)
    if (!response || response.status !== 404) return row.sessionId
    await db.delete(connectorScope).where(eq(connectorScope.userId, userId))
  }
  if (!options?.create) return null
  const pending = inflight.get(userId)
  if (pending) return pending
  const created = createScope(userId).finally(() => inflight.delete(userId))
  inflight.set(userId, created)
  return created
}
