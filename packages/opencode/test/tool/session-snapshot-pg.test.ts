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
      return Response.json({ id, createdAt: new Date().toISOString(), status: { state } })
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
})
