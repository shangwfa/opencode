import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Sandbox } from "@alibaba-group/opensandbox"
import { ConnectionConfig } from "@alibaba-group/opensandbox"
import { eq, like } from "drizzle-orm"
import { Database } from "../../src/storage/db"
import { SessionSnapshot } from "../../src/tool/session-snapshot"
import { SessionSnapshotTable } from "../../src/tool/session-snapshot.pg"

const DB_URL = process.env.OPENCODE_DATABASE_URL
const enabled = (() => {
  if (!DB_URL) return false
  const url = new URL(DB_URL)
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/opencode_test"
})()

const db = Database.Client()
let creates = 0
let failGets = 0
let failDeletes = false
let failReason: string | undefined
const states = new Map<string, "Creating" | "Ready" | "Failed">()

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname
    if (request.method === "POST" && path.includes("/sandboxes/") && path.endsWith("/snapshots")) {
      creates++
      await Bun.sleep(100)
      const id = `snap-${creates}`
      states.set(id, "Creating")
      return Response.json({ id, createdAt: new Date().toISOString(), status: { state: "Creating" } })
    }
    if (request.method === "GET" && path.includes("/snapshots/")) {
      if (failGets > 0) {
        failGets--
        return Response.json({ code: "TEMPORARY", message: "temporary failure" }, { status: 500 })
      }
      const id = path.split("/").at(-1)!
      const state = states.get(id)
      if (!state) return Response.json({ code: "NOT_FOUND", message: "missing" }, { status: 404 })
      return Response.json({ id, createdAt: new Date().toISOString(), status: { state, ...(failReason ? { reason: failReason } : {}) } })
    }
    if (request.method === "DELETE" && path.includes("/snapshots/")) {
      if (failDeletes) return Response.json({ code: "TEMPORARY", message: "temporary failure" }, { status: 500 })
      states.delete(path.split("/").at(-1)!)
      return new Response(null, { status: 204 })
    }
    return Response.json({ code: "NOT_FOUND", message: "missing" }, { status: 404 })
  },
})

const connectionConfig = new ConnectionConfig({ domain: server.url.host, protocol: "http" })
const make = () => SessionSnapshot.create({ pgDb: db, connectionConfig, ttlMs: 1, waitMs: 12_000 })
const sandbox = { id: "sb-snapshot-test" } as Sandbox

async function cleanup() {
  await db.delete(SessionSnapshotTable).where(like(SessionSnapshotTable.session_id, "ses_snapshot_test_%")).run()
  creates = 0
  failGets = 0
  failDeletes = false
  failReason = undefined
  states.clear()
}

describe.skipIf(!enabled)("SessionSnapshot PG state machine", () => {
  beforeAll(async () => {
    await Database.initialize()
    await cleanup()
  })

  afterAll(async () => {
    await cleanup()
    server.stop(true)
  })

  test("cross-instance startSnapshot reuses one creating snapshot", async () => {
    const sessionID = "ses_snapshot_test_claim"
    const [left, right] = await Promise.all([
      make().startSnapshot(sandbox, sessionID),
      make().startSnapshot(sandbox, sessionID),
    ])

    expect(left).toBeTruthy()
    expect(right).toBe(left)
    expect(creates).toBe(1)
  })

  test("temporary get failure is retried and Ready is durably persisted", async () => {
    const sessionID = "ses_snapshot_test_retry"
    const snapshots = make()
    const id = await snapshots.startSnapshot(sandbox, sessionID)
    expect(id).toBeTruthy()
    states.set(id!, "Ready")
    failGets = 1

    expect(await snapshots.awaitSnapshot(sessionID, id!)).toBe("ready")
    const rows = await db.select().from(SessionSnapshotTable).where(eq(SessionSnapshotTable.id, id!)).all()
    expect(rows[0]?.state).toBe("ready")
  }, 15_000)

  test("delete 500 stays deleting and GC retries", async () => {
    const sessionID = "ses_snapshot_test_delete"
    const snapshots = make()
    const id = await snapshots.startSnapshot(sandbox, sessionID)
    expect(id).toBeTruthy()
    failDeletes = true

    await snapshots.deleteAllForSession(sessionID)
    expect((await snapshots.getLatest(sessionID))?.state).toBeUndefined()
    const deleting = await db.select().from(SessionSnapshotTable).where(eq(SessionSnapshotTable.id, id!)).all()
    expect(deleting[0]?.state).toBe("deleting")

    failDeletes = false
    await snapshots.gc()
    const deleted = await db.select().from(SessionSnapshotTable).where(eq(SessionSnapshotTable.id, id!)).all()
    expect(deleted[0]?.state).toBe("deleted")
  })

  test("startSnapshot 持久化兼容性元数据", async () => {
    const sessionID = "ses_snapshot_test_meta"
    const id = await make().startSnapshot(sandbox, sessionID, {
      image: "img:v1",
      sourceSandboxId: "sb-meta",
      arch: "arm64",
      schemaVersion: 7,
      runtimeVersion: "1.2.3",
    })
    const row = (await db.select().from(SessionSnapshotTable).where(eq(SessionSnapshotTable.id, id!)).all())[0]
    expect(row.image).toBe("img:v1")
    expect(row.source_sandbox_id).toBe("sb-meta")
    expect(row.arch).toBe("arm64")
    expect(row.schema_version).toBe(7)
    expect(row.runtime_version).toBe("1.2.3")
    expect(row.restored_count).toBe(0)
    expect(row.last_restored_at).toBeNull()
  })

  test("markConsumed 递增 restored_count 并记录 last_restored_at", async () => {
    const sessionID = "ses_snapshot_test_consumed"
    const snapshots = make()
    const id = await snapshots.startSnapshot(sandbox, sessionID)
    states.set(id!, "Ready")
    expect(await snapshots.awaitSnapshot(sessionID, id!)).toBe("ready")

    await snapshots.markConsumed(id!)
    await snapshots.markConsumed(id!)
    const row = (await db.select().from(SessionSnapshotTable).where(eq(SessionSnapshotTable.id, id!)).all())[0]
    expect(row.state).toBe("stale")
    expect(row.restored_count).toBe(2)
    expect(Number(row.last_restored_at)).toBeGreaterThan(0)
  })

  test("awaitSnapshot 失败时落库远端 reason（排障）", async () => {
    const sessionID = "ses_snapshot_test_fail_reason"
    const snapshots = make()
    const id = await snapshots.startSnapshot(sandbox, sessionID)
    states.set(id!, "Failed")
    failReason = "RegistryNotConfigured"
    expect(await snapshots.awaitSnapshot(sessionID, id!)).toBe("failed")
    const row = (await db.select().from(SessionSnapshotTable).where(eq(SessionSnapshotTable.id, id!)).all())[0]
    expect(row.state).toBe("failed")
    expect(row.reason).toContain("RegistryNotConfigured")
    failReason = undefined
  })

  test("markIncompatible 标记 failed 并从可恢复集合移除", async () => {
    const sessionID = "ses_snapshot_test_incompat"
    const snapshots = make()
    const id = await snapshots.startSnapshot(sandbox, sessionID)
    states.set(id!, "Ready")
    await snapshots.awaitSnapshot(sessionID, id!)
    expect((await snapshots.resolveForCreate(sessionID))?.id).toBe(id!)

    await snapshots.markIncompatible(sessionID, id!, "schema 999 != 1")
    expect(await snapshots.resolveForCreate(sessionID)).toBeNull()
    const row = (await db.select().from(SessionSnapshotTable).where(eq(SessionSnapshotTable.id, id!)).all())[0]
    expect(row.state).toBe("failed")
    expect(row.reason).toContain("incompatible")
  })

  test("stats 聚合快照状态分布与 GC backlog", async () => {
    const SID = "ses_snapshot_test_stats"
    await db.delete(SessionSnapshotTable).where(like(SessionSnapshotTable.session_id, SID)).run()
    const now = Date.now()
    await db.insert(SessionSnapshotTable).values([
      { id: "stat_ready_1", session_id: SID, scope: "session", state: "ready", time_created: now, time_updated: now },
      { id: "stat_ready_2", session_id: SID, scope: "session", state: "ready", time_created: now, time_updated: now },
      { id: "stat_stale", session_id: SID, scope: "session", state: "stale", time_created: now, time_updated: now },
      { id: "stat_creating", session_id: SID, scope: "session", state: "creating", time_created: now, time_updated: now },
    ]).run()

    const s = await make().stats()
    expect(s.snapshots.ready).toBeGreaterThanOrEqual(2)
    expect(s.snapshots.stale).toBeGreaterThanOrEqual(1)
    expect(s.gc.creating).toBeGreaterThanOrEqual(1)
    expect(s.derived).toHaveProperty("reuseHitRate")
    expect(s.derived).toHaveProperty("fallbackRate")
    await db.delete(SessionSnapshotTable).where(like(SessionSnapshotTable.session_id, SID)).run()
  })
})
