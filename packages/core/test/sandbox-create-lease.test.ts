// 跨实例创建互斥（sandbox 行 state=creating 仲裁）PG 回归：
// claim 仲裁、lease 过期接管、失败释放、complete CAS、stale 清扫。
// 未设 OPENCODE_DATABASE_URL 时静默 skip。
import { expect } from "bun:test"
import { and, eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { SandboxCreateLease } from "@opencode/core/sandbox/lifecycle/create-lease"
import { SandboxTable } from "@opencode/core/sandbox/sql"
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
  (db as { delete: (t: typeof SandboxTable) => { where: (c: unknown) => { run: () => Effect.Effect<unknown> } } })
    .delete(SandboxTable)
    .where(eq(SandboxTable.session_id, sessionID))
    .run()

const rowOf = (db: unknown, sessionID: string) =>
  Effect.map(
    (db as Parameters<typeof cleanup>[0] & {
      select: () => {
        from: (t: typeof SandboxTable) => {
          where: (c: unknown) => { limit: (n: number) => { all: () => Effect.Effect<Array<Record<string, unknown>>> } }
        }
      }
    })
      .select()
      .from(SandboxTable)
      .where(eq(SandboxTable.session_id, sessionID))
      .limit(1)
      .all(),
    (rows) => rows[0] ?? null,
  )

pgTest("only one of two replicas wins the claim; the loser waits", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const sessionID = `lease-${Date.now()}-a`
    const a = SandboxCreateLease.create({ db, leaseMs: 60_000, host: "h" })
    const b = SandboxCreateLease.create({ db, leaseMs: 60_000, host: "h" })
    try {
      const first = yield* a.claim(sessionID)
      expect(first._tag).toBe("claimed"
      )
      if (first._tag !== "claimed") return
      const second = yield* b.claim(sessionID)
      expect(second._tag).toBe("wait")
      const row = yield* rowOf(db, sessionID)
      expect(row!.state).toBe("creating")
      expect(String(row!.id)).toBe(SandboxCreateLease.creatingID(first.owner))
    } finally {
      yield* cleanup(db, sessionID)
    }
  }),
)

pgTest("waiter joins once the winner completes; late takeover cannot overwrite", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const sessionID = `lease-${Date.now()}-b`
    const a = SandboxCreateLease.create({ db, leaseMs: 60_000, host: "h" })
    const b = SandboxCreateLease.create({ db, leaseMs: 60_000, host: "h" })
    try {
      const ac = yield* a.claim(sessionID)
      expect(ac._tag).toBe("claimed")
      if (ac._tag !== "claimed") return
      expect((yield* b.claim(sessionID))._tag).toBe("wait")
      const realID = "sb-real-1"
      expect(yield* a.complete(sessionID, ac.owner, realID)).toBe(true)
      // 另一持有者的 complete 被拒（行已不归它）
      expect(yield* b.complete(sessionID, "not-an-owner", "sb-bogus")).toBe(false)
      const row = yield* rowOf(db, sessionID)
      expect(row!.state).toBe("running")
      expect(String(row!.id)).toBe(realID)
      // complete 后新来者直接复用 running
      const c = SandboxCreateLease.create({ db, leaseMs: 60_000, host: "h" })
      const joiner = yield* c.claim(sessionID)
      expect(joiner).toMatchObject({ _tag: "running", sandboxID: realID })
    } finally {
      yield* cleanup(db, sessionID)
    }
  }),
)

pgTest("failed creator releases so a waiter retries immediately", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const sessionID = `lease-${Date.now()}-c`
    const a = SandboxCreateLease.create({ db, leaseMs: 60_000, host: "h" })
    const b = SandboxCreateLease.create({ db, leaseMs: 60_000, host: "h" })
    try {
      const ac = yield* a.claim(sessionID)
      expect(ac._tag).toBe("claimed")
      if (ac._tag !== "claimed") return
      yield* a.release(sessionID, ac.owner)
      const row = yield* rowOf(db, sessionID)
      expect(row!.state).toBe("destroyed")
      // 释放后等待者可立即重新仲裁
      expect((yield* b.claim(sessionID))._tag).toBe("claimed")
    } finally {
      yield* cleanup(db, sessionID)
    }
  }),
)

pgTest("an expired lease is taken over by another replica", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const sessionID = `lease-${Date.now()}-d`
    const a = SandboxCreateLease.create({ db, leaseMs: 60_000, host: "h" })
    const b = SandboxCreateLease.create({ db, leaseMs: 60_000, host: "h" })
    try {
      const ac = yield* a.claim(sessionID)
      expect(ac._tag).toBe("claimed")
      if (ac._tag !== "claimed") return
      // 模拟 a 崩溃：把 time_updated 拨到 lease 之前
      yield* db
        .update(SandboxTable)
        .set({ time_updated: Date.now() - 120_000 })
        .where(eq(SandboxTable.session_id, sessionID))
        .run()
      const takeover = yield* b.claim(sessionID)
      expect(takeover._tag).toBe("claimed")
      const row = yield* rowOf(db, sessionID)
      if (takeover._tag !== "claimed") return
      expect(String(row!.id)).toBe(SandboxCreateLease.creatingID(takeover.owner))
    } finally {
      yield* cleanup(db, sessionID)
    }
  }),
)

pgTest("one lease instance claiming two different sessions must not collide on the creating primary key", () =>
  // 回归：provider 全进程共享一个 lease 实例（同一 owner）。第一个 session 的
  // claim 落下 id=creating-<owner> 行后，第二个 session 用同一 id insert 会撞
  // sandbox 主键（onConflictDoUpdate 只仲裁 session_id），沙箱创建整体失败。
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const lease = SandboxCreateLease.create({ db, leaseMs: 60_000, host: "h" })
    const s1 = `lease-${Date.now()}-f1`
    const s2 = `lease-${Date.now()}-f2`
    try {
      const first = yield* lease.claim(s1)
      expect(first._tag).toBe("claimed")
      const second = yield* lease.claim(s2)
      expect(second._tag).toBe("claimed")
      const row1 = yield* rowOf(db, s1)
      const row2 = yield* rowOf(db, s2)
      expect(row1!.state).toBe("creating")
      expect(row2!.state).toBe("creating")
      expect(row1!.id).not.toBe(row2!.id)
    } finally {
      yield* cleanup(db, s1)
      yield* cleanup(db, s2)
    }
  }),
)

pgTest("sweepStaleCreating converges abandoned creating rows only", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const insert = (id: string, sessionID: string, state: string, ageMs: number) =>
      db
        .insert(SandboxTable)
        .values({
          id,
          session_id: sessionID,
          host: "h",
          state: state as never,
          keep_alive: false,
          time_created: Date.now() - ageMs,
          time_updated: Date.now() - ageMs,
        })
        .onConflictDoNothing()
        .run()
    const stale = `lease-${Date.now()}-e1`
    const fresh = `lease-${Date.now()}-e2`
    try {
      yield* insert(`creating-stale-${Date.now()}`, stale, "creating", 120_000)
      yield* insert(`creating-fresh-${Date.now()}`, fresh, "creating", 5_000)
      yield* SandboxCreateLease.sweepStaleCreating(db, 60_000)
      const staleRow = yield* rowOf(db, stale)
      const freshRow = yield* rowOf(db, fresh)
      expect(staleRow!.state).toBe("destroyed")
      expect(freshRow!.state).toBe("creating")
    } finally {
      yield* cleanup(db, stale)
      yield* cleanup(db, fresh)
    }
  }),
)
