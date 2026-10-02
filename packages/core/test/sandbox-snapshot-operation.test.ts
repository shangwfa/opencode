// 快照 durable 操作队列（snapshot_operation / snapshot_refresh_operation）PG 回归：
// 幂等入队、租约领取、fencing、退避与保留清理。未设 OPENCODE_DATABASE_URL 时静默 skip。
import { expect } from "bun:test"
import { and, eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { SandboxSnapshotOperation } from "@opencode/core/sandbox/snapshot-operation"
import { SnapshotOperationTable, SnapshotRefreshOperationTable } from "@opencode/core/sandbox/snapshot.sql"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/schema/schema"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node]),
    [Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") }))],
  ),
)
const pgTest = process.env.OPENCODE_DATABASE_URL ? it.effect : it.effect.skip

const cleanup = (db: unknown, sessionID: string) =>
  Effect.gen(function* () {
    const d = db as ReturnType<typeof makeDb>
    yield* d.delete(SnapshotOperationTable).where(eq(SnapshotOperationTable.session_id, sessionID)).run()
    yield* d.delete(SnapshotRefreshOperationTable).where(eq(SnapshotRefreshOperationTable.session_id, sessionID)).run()
  })

// Only the slices the queue touches; keeps the loose drizzle handle honest.
type AnyOperationTable = typeof SnapshotOperationTable | typeof SnapshotRefreshOperationTable
function makeDb(db: unknown) {
  return db as {
    delete: (t: AnyOperationTable) => { where: (c: unknown) => { run: () => Effect.Effect<unknown> } }
    update: (t: AnyOperationTable) => {
      set: (v: Record<string, unknown>) => { where: (c: unknown) => { run: () => Effect.Effect<unknown> } }
    }
    select: () => {
      from: (t: AnyOperationTable) => {
        where: (c: unknown) => { limit: (n: number) => { all: () => Effect.Effect<Array<Record<string, unknown>>> } }
      }
    }
    insert: (t: AnyOperationTable) => {
      values: (v: Record<string, unknown>) => { run: () => Effect.Effect<unknown> }
    }
  }
}

pgTest("enqueue converges concurrent inserts to one active row", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const sessionID = `op-test-${Date.now()}`
    const queue = SandboxSnapshotOperation.create(db, "destroy")
    try {
      const ids = []
      for (let i = 0; i < 6; i++) ids.push(yield* queue.enqueue({ sessionID, sandboxID: `sb-${sessionID}`, kind: "snapshot_destroy" }))
      expect(new Set(ids).size).toBe(1)
      const rows = yield* (makeDb(db).select().from(SnapshotOperationTable).where(eq(SnapshotOperationTable.session_id, sessionID)).limit(10).all())
      expect(rows.length).toBe(1)
      expect(rows[0]!.state).toBe((rows[0].state, "pending"))
    } finally {
      yield* cleanup(db, sessionID)
    }
  }),
)

pgTest("claim leases a pending row; a second instance cannot steal a live lease", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const sessionID = `op-test-${Date.now()}-b`
    const a = SandboxSnapshotOperation.create(db, "destroy")
    const b = SandboxSnapshotOperation.create(db, "destroy")
    try {
      const id = yield* a.enqueue({ sessionID, sandboxID: `sb-${sessionID}`, kind: "snapshot_destroy" })
      const claimed = yield* a.claim(sessionID)
      expect(claimed).not.toBeNull()
      expect(claimed!.state).toBe("running")
      expect(claimed!.attempts).toBe(1)
      expect(claimed!.fencing_token).toBe(1)
      // 租约未过期：另一实例领取不到（跳过本行，返回 null）
      const stolen = yield* b.claim(sessionID)
      expect(stolen === null || stolen.id !== id).toBe(true)
      // 旧 fencing token 的 complete 被拒（模拟接管后的旧执行者）
      expect(yield* b.complete(id, 1)).toBe(false)
      // 持有者可以正常续租并完成
      expect(yield* a.heartbeat(id, 1)).toBe(true)
      expect(yield* a.complete(id, 1)).toBe(true)
    } finally {
      yield* cleanup(db, sessionID)
    }
  }),
)

pgTest("an expired lease is taken over with a higher fencing token and attempts", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const d = makeDb(db)
    const sessionID = `op-test-${Date.now()}-c`
    const a = SandboxSnapshotOperation.create(db, "destroy")
    const b = SandboxSnapshotOperation.create(db, "destroy")
    try {
      yield* a.enqueue({ sessionID, sandboxID: `sb-${sessionID}`, kind: "snapshot_destroy" })
      const first = yield* a.claim(sessionID)
      expect(first).not.toBeNull()
      // 人为把租约置为过期（模拟持有实例崩溃后时间流逝）
      yield* d.update(SnapshotOperationTable).set({ lease_until: Date.now() - 1000 }).where(eq(SnapshotOperationTable.id, first!.id)).run()
      const takeover = yield* b.claim(sessionID)
      expect(takeover).not.toBeNull()
      expect(takeover!.id).toBe(first!.id)
      expect(takeover!.attempts).toBe(2)
      expect(takeover!.fencing_token).toBe(2)
      // 旧执行者（a, token=1）的 fail 被拒；新执行者成功
      expect(yield* a.fail(first!.id, 1, "stale", 1)).toBe(false)
      expect(yield* b.fail(first!.id, 2, "real error", 2)).toBe(true)
      const rows = yield* d.select().from(SnapshotOperationTable).where(eq(SnapshotOperationTable.id, first!.id)).limit(1).all()
      expect(rows[0]!.state).toBe("pending")
      expect(Number(rows[0]!.next_retry_at)).toBeGreaterThan(Date.now())
      // 退避未到期：不可立即重领
      const early = yield* b.claim(sessionID)
      expect(early === null || early.id !== first!.id).toBe(true)
    } finally {
      yield* cleanup(db, sessionID)
    }
  }),
)

pgTest("refresh queue refuses destroy kinds and tracks its own table", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const sessionID = `op-test-${Date.now()}-d`
    const refresh = SandboxSnapshotOperation.create(db, "refresh")
    const destroy = SandboxSnapshotOperation.create(db, "destroy")
    try {
      const exit = yield* refresh.enqueue({ sessionID, sandboxID: `sb-${sessionID}`, kind: "snapshot_destroy" }).pipe(Effect.result)
      expect(exit._tag).toBe("Failure")
      const id = yield* refresh.enqueue({ sessionID, sandboxID: `sb-${sessionID}`, kind: "snapshot_refresh" })
      const claimed = yield* refresh.claim(sessionID)
      expect(claimed).not.toBeNull()
      expect(claimed!.kind).toBe("snapshot_refresh")
      expect(yield* refresh.complete(id, claimed!.fencing_token)).toBe(true)
      // destroy 队列看不到 refresh 行
      const destroyClaim = yield* destroy.claim(sessionID)
      expect(destroyClaim === null || destroyClaim.kind === "snapshot_destroy").toBe(true)
      const stats = yield* refresh.stats(sessionID)
      const doneCount = (stats.byState as Record<string, number>)["done"] ?? 0
      expect(doneCount).toBeGreaterThanOrEqual(1)
    } finally {
      yield* cleanup(db, sessionID)
    }
  }),
)

pgTest("an expired owner cannot revive, complete or fail its lease before takeover", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const sessionID = `op-test-expired-${Date.now()}`
    const queue = SandboxSnapshotOperation.create(db, "destroy")
    try {
      yield* queue.enqueue({ sessionID, sandboxID: `sb-${sessionID}`, kind: "snapshot_destroy" })
      const operation = yield* queue.claim(sessionID)
      if (!operation) throw new Error("Expected scoped operation")
      yield* makeDb(db).update(SnapshotOperationTable).set({ lease_until: Date.now() - 1000 }).where(eq(SnapshotOperationTable.id, operation.id)).run()
      expect(yield* queue.heartbeat(operation.id, operation.fencing_token)).toBe(false)
      expect(yield* queue.complete(operation.id, operation.fencing_token)).toBe(false)
      expect(yield* queue.fail(operation.id, operation.fencing_token, "stale", operation.attempts)).toBe(false)
    } finally {
      yield* cleanup(db, sessionID)
    }
  }),
)

pgTest("retention removes terminal rows past the window", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const d = makeDb(db)
    const sessionID = `op-test-${Date.now()}-e`
    const queue = SandboxSnapshotOperation.create(db, "destroy")
    try {
      yield* queue.enqueue({ sessionID, sandboxID: `sb-${sessionID}`, kind: "snapshot_destroy" })
      // 直接造一条 8 天前完成的终态行
      const old = `old-${sessionID}`
      const now = Date.now()
      yield* makeDb(db).insert(SnapshotOperationTable).values({
        id: old,
        session_id: sessionID,
        sandbox_id: `sb-${sessionID}`,
        kind: "snapshot_destroy",
        state: "done",
        attempts: 1,
        next_retry_at: null,
        lease_owner: null,
        lease_until: null,
        fencing_token: 1,
        error: null,
        time_created: now - 8 * 24 * 3600 * 1000,
        time_updated: now - 8 * 24 * 3600 * 1000,
      }).run()
      yield* queue.retention()
      const rows = yield* d.select().from(SnapshotOperationTable).where(eq(SnapshotOperationTable.id, old)).limit(1).all()
      expect(rows.length).toBe(0)
    } finally {
      yield* cleanup(db, sessionID)
    }
  }),
)
