import { and, eq, inArray, sql } from "drizzle-orm"
import { randomUUID } from "node:crypto"
import { Log } from "@opencode-ai/core/util/log"
import { SnapshotOperationTable } from "./session-snapshot.pg"

const log = Log.create({ service: "snapshot-operation" })

/** 租约时长；执行体应每 LEASE_MS/3 续租一次，续租失败说明已被接管，须立即停止副作用。 */
export const LEASE_MS = 5 * 60 * 1000
const MAX_ATTEMPTS = 5
const BASE_BACKOFF_MS = 30_000
const MAX_BACKOFF_MS = 10 * 60 * 1000
const ownerID = randomUUID()

export type SnapshotOperationKind = "snapshot_destroy"
export type SnapshotOperationRow = typeof SnapshotOperationTable.$inferSelect

/** 快照编排操作的持久化队列。enqueue 只落库，执行由各实例的 worker 通过租约领取，
 * 进程崩溃后 lease 过期可被其他实例接管（跨 pod 至少一次执行，执行体须幂等）。
 * fencing_token 每次领取单调递增：租约过期被接管后，旧执行者的 complete/fail/续租都会失败。 */
export function create(pgDb: any) {
  async function activeRow(sessionID: string, sandboxID: string, kind: SnapshotOperationKind) {
    const rows: SnapshotOperationRow[] = await pgDb
      .select()
      .from(SnapshotOperationTable)
      .where(and(
        eq(SnapshotOperationTable.session_id, sessionID),
        eq(SnapshotOperationTable.sandbox_id, sandboxID),
        eq(SnapshotOperationTable.kind, kind),
        inArray(SnapshotOperationTable.state, ["pending", "running"]),
      ))
      .orderBy(SnapshotOperationTable.time_created)
      .limit(1)
      .all()
    return rows[0] ?? null
  }

  /** 入队（幂等）：部分唯一索引保证同 session+sandbox+kind 至多一条 pending/running，
   * 并发插入由 ON CONFLICT DO NOTHING + 回读收敛到同一条。 */
  async function enqueue(input: { sessionID: string; sandboxID: string; kind: SnapshotOperationKind }) {
    const id = randomUUID()
    const now = Date.now()
    await pgDb
      .insert(SnapshotOperationTable)
      .values({
        id,
        session_id: input.sessionID,
        sandbox_id: input.sandboxID,
        kind: input.kind,
        state: "pending",
        attempts: 0,
        next_retry_at: null,
        lease_owner: null,
        lease_until: null,
        fencing_token: 0,
        error: null,
        time_created: now,
        time_updated: now,
      })
      .onConflictDoNothing()
      .run()
    return (await activeRow(input.sessionID, input.sandboxID, input.kind))?.id ?? id
  }

  /** 领取一条可执行操作（pending 到期或 running 租约过期），递增 fencing_token。 */
  async function claim(now = Date.now()): Promise<SnapshotOperationRow | null> {
    const rows = await pgDb.execute(sql`
      UPDATE snapshot_operation
      SET state = 'running', lease_owner = ${ownerID}, lease_until = ${now + LEASE_MS},
          attempts = attempts + 1, fencing_token = fencing_token + 1, time_updated = ${now}
      WHERE id = (
        SELECT id FROM snapshot_operation
        WHERE (state = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= ${now}))
           OR (state = 'running' AND lease_until < ${now})
        ORDER BY time_created ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `)
    return (rows as SnapshotOperationRow[])[0] ?? null
  }

  /** 续租：仅当仍持有该 fencing_token 时成功；返回 false 表示已被接管，执行体须中止。 */
  async function heartbeat(id: string, fencingToken: number): Promise<boolean> {
    const now = Date.now()
    const rows = await pgDb.execute(sql`
      UPDATE snapshot_operation
      SET lease_until = ${now + LEASE_MS}, time_updated = ${now}
      WHERE id = ${id} AND lease_owner = ${ownerID} AND fencing_token = ${fencingToken} AND state = 'running'
      RETURNING id
    `)
    return (rows as unknown[]).length > 0
  }

  async function complete(id: string, fencingToken: number) {
    const now = Date.now()
    await pgDb.execute(sql`
      UPDATE snapshot_operation
      SET state = 'done', lease_owner = NULL, lease_until = NULL, error = NULL, time_updated = ${now}
      WHERE id = ${id} AND fencing_token = ${fencingToken}
    `)
  }

  /** 失败：指数退避后重回 pending；超过上限转 failed。带 fencing，避免旧执行者覆盖新执行者状态。 */
  async function fail(id: string, fencingToken: number, error: string) {
    const now = Date.now()
    await pgDb.execute(sql`
      UPDATE snapshot_operation
      SET state = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'pending' END,
          next_retry_at = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN next_retry_at
                               ELSE ${now} + LEAST(${MAX_BACKOFF_MS}::bigint, (${BASE_BACKOFF_MS}::bigint * power(2, attempts))::bigint) END,
          error = ${error},
          lease_owner = NULL, lease_until = NULL, time_updated = ${now}
      WHERE id = ${id} AND fencing_token = ${fencingToken}
    `)
    log.warn("snapshot operation failed", { id, error })
  }

  return { enqueue, claim, heartbeat, complete, fail }
}

export type SnapshotOperations = ReturnType<typeof create>

export * as SnapshotOperation from "./snapshot-operation"
