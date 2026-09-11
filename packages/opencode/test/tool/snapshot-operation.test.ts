import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { eq, like } from "drizzle-orm"
import { Database } from "../../src/storage/db"
import { SnapshotOperation } from "../../src/tool/snapshot-operation"
import { SnapshotOperationTable } from "../../src/tool/session-snapshot.pg"

const DB_URL = process.env.OPENCODE_DATABASE_URL
const enabled = (() => {
  if (!DB_URL) return false
  const url = new URL(DB_URL)
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/opencode_test"
})()

const db = Database.Client()
const ops = SnapshotOperation.create(db)
const SID = "ses_snapop_test"

async function cleanup() {
  await db.delete(SnapshotOperationTable).where(like(SnapshotOperationTable.session_id, "ses_snapop_%")).run()
}

async function row(id: string) {
  const rows = await db.select().from(SnapshotOperationTable).where(eq(SnapshotOperationTable.id, id)).all()
  return rows[0]
}

describe.skipIf(!enabled)("snapshot operation queue", () => {
  beforeAll(async () => {
    await Database.initialize()
    await cleanup()
  })

  afterAll(async () => {
    await cleanup()
  })

  test("enqueue 去重：同 session+sandbox+kind 复用同一条 pending", async () => {
    await cleanup()
    const a = await ops.enqueue({ sessionID: SID, sandboxID: "sb1", kind: "snapshot_destroy" })
    const b = await ops.enqueue({ sessionID: SID, sandboxID: "sb1", kind: "snapshot_destroy" })
    expect(a).toBe(b)
    const rows = await db.select().from(SnapshotOperationTable).where(eq(SnapshotOperationTable.session_id, SID)).all()
    expect(rows.length).toBe(1)
    expect(rows[0].state).toBe("pending")
  })

  test("并发 enqueue 由唯一索引收敛为一条", async () => {
    await cleanup()
    const ids = await Promise.all(
      Array.from({ length: 6 }, () => ops.enqueue({ sessionID: SID, sandboxID: "sb-conc", kind: "snapshot_destroy" })),
    )
    expect(new Set(ids).size).toBe(1)
    const rows = await db.select().from(SnapshotOperationTable).where(eq(SnapshotOperationTable.session_id, SID)).all()
    expect(rows.length).toBe(1)
  })

  test("claim 领取后 running、attempts=1、fencing=1、持有租约", async () => {
    await cleanup()
    const id = await ops.enqueue({ sessionID: SID, sandboxID: "sb2", kind: "snapshot_destroy" })
    const claimed = await ops.claim()
    expect(claimed?.id).toBe(id)
    expect(claimed?.state).toBe("running")
    expect(claimed?.attempts).toBe(1)
    expect(Number(claimed?.fencing_token)).toBe(1)
    expect(claimed?.lease_owner).toBeTruthy()
    expect(Number(claimed?.lease_until)).toBeGreaterThan(Date.now())
  })

  test("无待执行操作时 claim 返回 null", async () => {
    await cleanup()
    expect(await ops.claim()).toBeNull()
  })

  test("heartbeat 持租约成功、失去租约失败", async () => {
    await cleanup()
    await ops.enqueue({ sessionID: SID, sandboxID: "sb-hb", kind: "snapshot_destroy" })
    const claimed = (await ops.claim())!
    expect(await ops.heartbeat(claimed.id, claimed.fencing_token)).toBe(true)
    expect(await ops.heartbeat(claimed.id, claimed.fencing_token + 99)).toBe(false)
  })

  test("complete → done", async () => {
    await cleanup()
    await ops.enqueue({ sessionID: SID, sandboxID: "sb3", kind: "snapshot_destroy" })
    const claimed = (await ops.claim())!
    await ops.complete(claimed.id, claimed.fencing_token)
    expect((await row(claimed.id)).state).toBe("done")
  })

  test("fencing：旧 token 的 complete 无法覆盖被接管后的状态", async () => {
    await cleanup()
    await ops.enqueue({ sessionID: SID, sandboxID: "sb-fence", kind: "snapshot_destroy" })
    const first = (await ops.claim())!
    // 模拟租约过期后被另一实例接管（fencing 递增）
    await db.update(SnapshotOperationTable).set({ lease_until: Date.now() - 1_000 }).where(eq(SnapshotOperationTable.id, first.id)).run()
    const second = (await ops.claim())!
    expect(Number(second.fencing_token)).toBe(2)
    // 旧执行者的 complete 应被 fencing 拒绝
    await ops.complete(first.id, first.fencing_token)
    expect((await row(first.id)).state).toBe("running")
    // 新执行者可以完成
    await ops.complete(second.id, second.fencing_token)
    expect((await row(first.id)).state).toBe("done")
  })

  test("fail 未达上限 → 回 pending 且退避到未来", async () => {
    await cleanup()
    await ops.enqueue({ sessionID: SID, sandboxID: "sb4", kind: "snapshot_destroy" })
    const claimed = (await ops.claim())!
    const before = Date.now()
    await ops.fail(claimed.id, claimed.fencing_token, "boom")
    const failed = await row(claimed.id)
    expect(failed.state).toBe("pending")
    expect(Number(failed.next_retry_at)).toBeGreaterThan(before)
    expect(failed.error).toBe("boom")
  })

  test("running 租约过期后可被重新领取（attempts 累加）", async () => {
    await cleanup()
    await ops.enqueue({ sessionID: SID, sandboxID: "sb5", kind: "snapshot_destroy" })
    const first = (await ops.claim())!
    await db.update(SnapshotOperationTable).set({ lease_until: Date.now() - 1_000 }).where(eq(SnapshotOperationTable.id, first.id)).run()
    const reclaimed = await ops.claim()
    expect(reclaimed?.id).toBe(first.id)
    expect(reclaimed?.attempts).toBe(2)
  })

  test("退避未到期时不被领取", async () => {
    await cleanup()
    await ops.enqueue({ sessionID: SID, sandboxID: "sb6", kind: "snapshot_destroy" })
    const claimed = (await ops.claim())!
    await ops.fail(claimed.id, claimed.fencing_token, "transient")
    expect(await ops.claim()).toBeNull()
  })
})
