import { SandboxApiException, SandboxManager } from "@alibaba-group/opensandbox"
import type { Sandbox, ConnectionConfig } from "@alibaba-group/opensandbox"
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm"
import * as Log from "@opencode-ai/core/util/log"
import { SessionSnapshotTable } from "./session-snapshot.pg"

export type SnapshotDeps = {
  readonly pgDb: any
  readonly connectionConfig: ConnectionConfig
  readonly ttlMs: number
  readonly waitMs: number
}

export type SnapshotRow = typeof SessionSnapshotTable.$inferSelect

/**
 * 会话沙箱快照（本地盘 + 快照分层，见 docs/sandbox-snapshot-design.md）。
 * 快照失败不阻塞会话进程，但自动回收必须在 Ready 状态成功落库后才能销毁源沙箱。
 */
export namespace SessionSnapshot {
  const log = Log.create({ service: "session-snapshot" })
  const POLL_INTERVAL_MS = 5_000

  export function create(deps: SnapshotDeps) {
    const manager = SandboxManager.create({ connectionConfig: deps.connectionConfig })

    async function findRestorable(sessionID: string): Promise<SnapshotRow | null> {
      const rows: SnapshotRow[] = await deps.pgDb
        .select()
        .from(SessionSnapshotTable)
        .where(and(
          eq(SessionSnapshotTable.session_id, sessionID),
          eq(SessionSnapshotTable.scope, "session"),
          inArray(SessionSnapshotTable.state, ["ready", "stale"]),
        ))
        .orderBy(desc(SessionSnapshotTable.time_created))
        .limit(1)
        .all()
      return rows[0] ?? null
    }

    async function setState(
      id: string,
      state: SnapshotRow["state"],
      reason: string | null,
      expected?: SnapshotRow["state"][],
    ) {
      const rows = await deps.pgDb
        .update(SessionSnapshotTable)
        .set({ state, reason, time_updated: Date.now() })
        .where(and(
          eq(SessionSnapshotTable.id, id),
          ...(expected ? [inArray(SessionSnapshotTable.state, expected)] : []),
        ))
        .returning({ id: SessionSnapshotTable.id })
        .all()
      return rows.length > 0
    }

    /** createSandbox 前调用：返回可恢复快照 id（无则 null，走镜像冷启动）。 */
    async function resolveForCreate(sessionID: string): Promise<string | null> {
      try {
        return (await findRestorable(sessionID))?.id ?? null
      } catch (e) {
        log.warn("findRestorable failed; cold start", { sessionID, error: String(e) })
        return null
      }
    }

    /** 快照恢复失败：标记 failed，下次走镜像冷启动。 */
    async function markRestoreFailed(sessionID: string, snapshotId: string, reason: string) {
      try {
        await deps.pgDb
          .update(SessionSnapshotTable)
          .set({ state: "failed", reason: `restore failed: ${reason}`, time_updated: Date.now() })
          .where(and(
            eq(SessionSnapshotTable.id, snapshotId),
            eq(SessionSnapshotTable.session_id, sessionID),
            inArray(SessionSnapshotTable.state, ["ready", "stale"]),
          ))
          .run()
        log.warn("snapshot restore failed; marked", { sessionID, snapshotId, reason })
      } catch (e) {
        log.warn("markRestoreFailed db update failed", { snapshotId, error: String(e) })
      }
    }

    /** 恢复成功：标记 stale（已消费）。stale 仍可恢复（运行中沙箱异常退出的回退），直到被新快照替代。 */
    async function markConsumed(snapshotId: string) {
      try {
        await setState(snapshotId, "stale", "restored", ["ready", "stale"])
      } catch (e) {
        log.warn("markConsumed db update failed", { snapshotId, error: String(e) })
      }
    }

    /** 同会话旧快照清理（只保留最新，见设计 §4.1）。 */
    async function deleteSiblingSnapshots(sessionID: string, keepId: string) {
      const rows: SnapshotRow[] = await deps.pgDb
        .select()
        .from(SessionSnapshotTable)
        .where(and(
          eq(SessionSnapshotTable.session_id, sessionID),
          eq(SessionSnapshotTable.scope, "session"),
          inArray(SessionSnapshotTable.state, ["ready", "stale", "failed"]),
        ))
        .all()
      for (const row of rows) {
        if (row.id === keepId) continue
        await deleteSnapshot(row, "superseded")
      }
    }

    /**
     * 快照 id 回填会话元信息（merge，不覆盖业务字段）：业务方从 GET /session 直接拿派生/回滚用的 snapshotId。
     * 限制：裸 SQL 直写不触发 session.updated SSE 事件（tool 层无法依赖 session 服务，否则循环依赖）；
     * 业务方在下一次 GET /session 或页面刷新时可见，快照回填是低频异步事件，可接受。
     */
    async function backfillMetadata(sessionID: string, snapshotId: string) {
      await deps.pgDb
        .execute(sql`
          UPDATE session
          SET metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ sandboxSnapshot: { id: snapshotId, time: Date.now() } })}::jsonb
          WHERE id = ${sessionID}
        `)
        .catch((e: unknown) => log.warn("metadata backfill failed", { sessionID, snapshotId, error: String(e) }))
    }

    /**
     * 发起快照：createSnapshot + 落 creating 记录，立即返回快照 id（不等待 Ready）。
     * 去重：已有 creating 快照时直接返回其 id（并发 fiber 等同一个快照，避免重复 commit；
     * 卡死的 creating 由 gc 对账修正为 failed，下轮重试可正常发起新快照）。
     */
    async function startSnapshot(sb: Sandbox, sessionID: string): Promise<string | null> {
      let createdId: string | null = null
      try {
        return await deps.pgDb.transaction(async (tx: any) => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`session-snapshot:${sessionID}`}))`)
          const existing: SnapshotRow[] = await tx
            .select()
            .from(SessionSnapshotTable)
            .where(and(
              eq(SessionSnapshotTable.session_id, sessionID),
              eq(SessionSnapshotTable.scope, "session"),
              eq(SessionSnapshotTable.state, "creating"),
            ))
            .orderBy(desc(SessionSnapshotTable.time_created))
            .limit(1)
            .all()
          if (existing[0]) return existing[0].id

          const info = await manager.createSnapshot(sb.id, { name: sessionID })
          createdId = info.id
          await tx
            .insert(SessionSnapshotTable)
            .values({
              id: info.id,
              session_id: sessionID,
              scope: "session",
              state: "creating",
              time_created: Date.now(),
              time_updated: Date.now(),
            })
            .run()
          return info.id
        })
      } catch (e) {
        if (createdId) await manager.deleteSnapshot(createdId).catch(() => undefined)
        log.warn("createSnapshot failed", { sessionID, error: String(e) })
        return null
      }
    }

    /**
     * 等待快照到终态并收尾（Ready：标 ready + 清旧 + 回填；Failed/超时：标 failed）。
     * caller 须在快照 Ready 后才销毁源沙箱（Creating 中 kill 会使快照 Failed，实测坑）。
     */
    async function awaitSnapshot(sessionID: string, snapshotId: string): Promise<"ready" | "failed"> {
      const startedAt = Date.now()
      const deadline = startedAt + deps.waitMs
      while (Date.now() < deadline) {
        let state: string
        try {
          state = (await manager.getSnapshot(snapshotId)).status.state
        } catch (e) {
          log.warn("getSnapshot failed; retrying", { sessionID, snapshotId, error: String(e) })
          await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS))
          continue
        }
        if (state === "Ready") {
          const persisted = await setState(snapshotId, "ready", null, ["creating"]).catch(() => false)
          if (!persisted) {
            const current = await getById(snapshotId).catch(() => null)
            if (current?.state !== "ready") {
              log.warn("snapshot ready but state was not persisted; keeping sandbox", { sessionID, snapshotId, state: current?.state })
              return "failed"
            }
          }
          await deleteSiblingSnapshots(sessionID, snapshotId).catch((e) =>
            log.warn("sibling snapshot cleanup failed", { sessionID, snapshotId, error: String(e) }))
          await backfillMetadata(sessionID, snapshotId)
          log.info("snapshot ready", { sessionID, snapshotId, waitedMs: Date.now() - startedAt })
          return "ready"
        }
        if (state === "Failed") {
          await setState(snapshotId, "failed", "server reported Failed", ["creating"]).catch(() => undefined)
          log.warn("snapshot failed", { sessionID, snapshotId })
          return "failed"
        }
        await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS))
      }
      // 超时不代表远端失败，保持 creating，由下轮重试或 GC 继续对账。
      await setState(snapshotId, "creating", "wait timeout", ["creating"]).catch(() => undefined)
      log.warn("snapshot wait timeout", { sessionID, snapshotId, waitMs: deps.waitMs })
      return "failed"
    }

    /** 查询会话最新快照（任意状态，按时间倒序；GET /session/:id/snapshot 用）。 */
    async function getLatest(sessionID: string): Promise<SnapshotRow | null> {
      try {
        const rows: SnapshotRow[] = await deps.pgDb
          .select()
          .from(SessionSnapshotTable)
          .where(and(
            eq(SessionSnapshotTable.session_id, sessionID),
            eq(SessionSnapshotTable.scope, "session"),
            inArray(SessionSnapshotTable.state, ["creating", "ready", "stale", "failed"]),
          ))
          .orderBy(desc(SessionSnapshotTable.time_created))
          .limit(1)
          .all()
        return rows[0] ?? null
      } catch {
        return null
      }
    }

    async function getById(id: string): Promise<SnapshotRow | null> {
      const rows: SnapshotRow[] = await deps.pgDb
        .select()
        .from(SessionSnapshotTable)
        .where(eq(SessionSnapshotTable.id, id))
        .limit(1)
        .all()
      return rows[0] ?? null
    }

    async function deleteSnapshot(row: SnapshotRow, reason: string) {
      if (row.state !== "deleting") {
        const claimed = await setState(row.id, "deleting", reason, ["creating", "ready", "stale", "failed", "retired"])
        if (!claimed) return
      }
      try {
        await manager.deleteSnapshot(row.id)
      } catch (error) {
        if (!(error instanceof SandboxApiException && error.statusCode === 404)) {
          log.warn("snapshot delete failed; queued for retry", { snapshotId: row.id, sessionID: row.session_id, error: String(error) })
          return
        }
      }
      await setState(row.id, "deleted", reason, ["deleting"])
    }

    /**
     * GC + 对账（挂在 idle reap 扫描周期）：
     * 1. TTL 过期的终态快照 → 远端删除 + 标记 deleted
     * 2. creating 超时对账：远端实际 Ready 则修正并清旧，否则标 failed
     */
    async function gc(): Promise<void> {
      const now = Date.now()
      const expired: SnapshotRow[] = await deps.pgDb
        .select()
        .from(SessionSnapshotTable)
        .where(or(
          eq(SessionSnapshotTable.state, "deleting"),
          and(
            inArray(SessionSnapshotTable.state, ["ready", "stale", "failed"]),
            lt(SessionSnapshotTable.time_created, now - deps.ttlMs),
          ),
        ))
        .limit(50)
        .all()
      for (const row of expired) {
        await deleteSnapshot(row, row.state === "deleting" ? row.reason ?? "delete retry" : "ttl expired")
        log.info("snapshot gc", { snapshotId: row.id, sessionID: row.session_id })
      }

      const stuck: SnapshotRow[] = await deps.pgDb
        .select()
        .from(SessionSnapshotTable)
        .where(and(
          eq(SessionSnapshotTable.state, "creating"),
          lt(SessionSnapshotTable.time_created, now - deps.waitMs - 60_000),
        ))
        .limit(20)
        .all()
      for (const row of stuck) {
        let state: string | null = null
        try {
          state = (await manager.getSnapshot(row.id)).status.state
        } catch (error) {
          log.warn("snapshot reconcile query failed; keeping creating", { snapshotId: row.id, sessionID: row.session_id, error: String(error) })
          continue
        }
        if (state === "Ready") {
          const persisted = await setState(row.id, "ready", "reconciled", ["creating"]).catch(() => false)
          if (!persisted) continue
          if (row.session_id) {
            await deleteSiblingSnapshots(row.session_id, row.id).catch(() => undefined)
            await backfillMetadata(row.session_id, row.id)
          }
        } else if (state === "Failed") {
          await setState(row.id, "failed", "reconcile: Failed", ["creating"]).catch(() => undefined)
        }
        log.info("snapshot reconcile", { snapshotId: row.id, sessionID: row.session_id, state })
      }
    }

    /** 会话删除联动：清理该会话全部快照记录与远端快照。 */
    async function deleteAllForSession(sessionID: string): Promise<void> {
      const rows: SnapshotRow[] = await deps.pgDb
        .select()
        .from(SessionSnapshotTable)
        .where(eq(SessionSnapshotTable.session_id, sessionID))
        .all()
      for (const row of rows) {
        if (row.state === "deleted") continue
        await deleteSnapshot(row, "session deleted").catch((error) =>
          log.warn("snapshot delete enqueue failed", { snapshotId: row.id, sessionID, error: String(error) }))
      }
    }

    return {
      resolveForCreate, markRestoreFailed, markConsumed,
      startSnapshot, awaitSnapshot, getLatest, gc, deleteAllForSession,
    }
  }

  export type SessionSnapshots = ReturnType<typeof create>
}
