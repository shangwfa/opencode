// HITL store 单测：
// - sameTransition 纯函数（无条件跑）
// - PG 路径（CAS 幂等/冲突/隔离、原子限流、租约 claim、retention）
//   需要本地测试库：
//   OPENCODE_DATABASE_URL=postgresql://local@127.0.0.1:15432/opencode_test bun test test/hitl/store.test.ts
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import postgres from "postgres"
import { eq } from "drizzle-orm"
import { Database } from "../../src/storage/db"
import { HitlStore } from "../../src/hitl/store"
import { HitlRequestTable } from "../../src/hitl/request.pg"
import { SessionTable } from "../../src/session/session.pg"
import { SessionID } from "../../src/session/schema"

const DB_URL = process.env.OPENCODE_DATABASE_URL
const enabled = (() => {
  if (!DB_URL) return false
  const url = new URL(DB_URL)
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/opencode_test"
})()
const fixtureDb = DB_URL ? postgres(DB_URL as string) : undefined

const DIRECTORY = "/tmp/hitl-store-test"
const PROJECT_ID = "hitl-store-test-project"
let sequence = 0

const id = (prefix: string) => `${prefix}_${Date.now()}_${++sequence}`

type FixtureRow = {
  id: string
  kind?: HitlStore.Kind
  directory?: string
  userID?: string
  sessionID?: string
  ownerID?: string
  status?: HitlStore.Status
  payload?: Record<string, unknown>
  result?: Record<string, unknown> | null
  closeReason?: string | null
  leaseUntil?: number | null
}

async function insertRow(row: FixtureRow) {
  if (!fixtureDb) throw new Error("local PostgreSQL is required")
  const now = Date.now()
  // jsonb params must be passed as objects (postgres.js JSON-serializes them);
  // passing a pre-stringified value with a ::jsonb cast stores a jsonb string
  // scalar instead of the object.
  await fixtureDb.unsafe(
    `INSERT INTO hitl_request (
       id, kind, directory, user_id, session_id, owner_id, status, payload, result, close_reason, lease_until, time_created, time_updated
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      row.id,
      row.kind ?? "question",
      row.directory ?? DIRECTORY,
      row.userID ?? "",
      row.sessionID ?? `ses_${row.id}`,
      row.ownerID ?? "owner-test",
      row.status ?? "pending",
      (row.payload ?? {}) as never,
      (row.result ?? null) as never,
      row.closeReason ?? null,
      row.leaseUntil ?? now + HitlStore.LEASE_TTL_MS,
      now,
      now,
    ],
  )
}

async function fetchRow(rid: string) {
  if (!fixtureDb) throw new Error("local PostgreSQL is required")
  const rows = await fixtureDb.unsafe("SELECT * FROM hitl_request WHERE id = $1", [rid])
  return rows[0] as unknown as
    | {
        id: string
        kind: string
        directory: string
        session_id: string
        owner_id: string
        status: string
        result: Record<string, unknown> | null
        close_reason: string | null
        lease_until: string | number | null
        time_created: string | number
        time_updated: string | number
      }
    | undefined
}

describe("HitlStore.sameTransition", () => {
  const pendingRow = (overrides: Partial<HitlStore.Row>): HitlStore.Row => ({
    id: "que_x",
    kind: "question",
    directory: DIRECTORY,
    user_id: "",
    session_id: "ses_x",
    owner_id: "owner",
    status: "replied",
    payload: {},
    result: null,
    close_reason: null,
    lease_until: 1,
    time_created: 1,
    time_updated: 1,
    ...overrides,
  })

  test("identical status + result is idempotent", () => {
    expect(
      HitlStore.sameTransition(pendingRow({ status: "replied", result: { answers: [["yes"]] } }), {
        status: "replied",
        result: { answers: [["yes"]] },
      }),
    ).toBe(true)
  })

  test("different result with same status is a conflict", () => {
    expect(
      HitlStore.sameTransition(pendingRow({ status: "replied", result: { answers: [["yes"]] } }), {
        status: "replied",
        result: { answers: [["no"]] },
      }),
    ).toBe(false)
  })

  test("different status is a conflict", () => {
    expect(HitlStore.sameTransition(pendingRow({ status: "rejected" }), { status: "replied" })).toBe(false)
  })

  test("close_reason participates in comparison", () => {
    expect(
      HitlStore.sameTransition(pendingRow({ status: "closed", close_reason: "instance-restart" }), {
        status: "closed",
        closeReason: "instance-restart",
      }),
    ).toBe(true)
    expect(
      HitlStore.sameTransition(pendingRow({ status: "closed", close_reason: "instance-restart" }), {
        status: "closed",
        closeReason: "answered-delivered",
      }),
    ).toBe(false)
  })

  test("key order inside result does not matter", () => {
    expect(
      HitlStore.sameTransition(pendingRow({ result: { reply: "reject", message: "fix it" } }), {
        status: "replied",
        result: { message: "fix it", reply: "reject" },
      }),
    ).toBe(true)
  })
})

describe.skipIf(!enabled)("HitlStore PostgreSQL", () => {
  const sessionIDs: string[] = []
  const rowIDs: string[] = []

  async function createSession() {
    if (!fixtureDb) throw new Error("local PostgreSQL is required")
    const sessionID = SessionID.make(id("ses_hitl"))
    const now = Date.now()
    await fixtureDb.unsafe(
      `INSERT INTO session (
         id, project_id, directory, slug, title, version, time_created, time_updated,
         cost, tokens_input, tokens_output, tokens_reasoning
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, 0, 0, 0)`,
      [sessionID, PROJECT_ID, DIRECTORY, "hitl-store-test", "HITL store test", "test", now, now],
    )
    sessionIDs.push(sessionID)
    return sessionID
  }

  beforeAll(async () => {
    await Database.initialize()
    if (!fixtureDb) return
    const now = Date.now()
    await fixtureDb.unsafe(
      `INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [PROJECT_ID, DIRECTORY, now, now, "[]"],
    )
  })

  afterAll(async () => {
    if (!fixtureDb) return
    await fixtureDb.unsafe("DELETE FROM project WHERE id = $1", [PROJECT_ID])
    await fixtureDb.end()
  })

  afterEach(async () => {
    const db = Database.Client()
    for (const rid of rowIDs)
      await db
        .delete(HitlRequestTable)
        .where(eq(HitlRequestTable.id, rid as never))
        .run()
    for (const sid of sessionIDs)
      await db
        .delete(SessionTable)
        .where(eq(SessionTable.id, sid as never))
        .run()
    rowIDs.length = 0
    sessionIDs.length = 0
  })

  test("insertPendingLimited admits within limit and rejects beyond it", async () => {
    const sessionID = await createSession()
    for (let i = 0; i < 3; i++) {
      const rid = id("que_limit")
      rowIDs.push(rid)
      const ok = await HitlStore.insertPendingLimited(
        { id: rid, kind: "question", directory: DIRECTORY, userID: "", sessionID, ownerID: "owner-a", payload: {} },
        3,
      )
      expect(ok).toBe(true)
    }
    const over = id("que_limit_over")
    rowIDs.push(over)
    const ok = await HitlStore.insertPendingLimited(
      { id: over, kind: "question", directory: DIRECTORY, userID: "", sessionID, ownerID: "owner-a", payload: {} },
      3,
    )
    expect(ok).toBe(false)
    const row = await fetchRow(over)
    expect(row).toBeUndefined()
  })

  test("insertPendingLimited is atomic under concurrent inserts", async () => {
    const sessionID = await createSession()
    const limit = 5
    const ids = Array.from({ length: 20 }, () => id("que_race"))
    rowIDs.push(...ids)
    const results = await Promise.all(
      ids.map((rid) =>
        HitlStore.insertPendingLimited(
          { id: rid, kind: "question", directory: DIRECTORY, userID: "", sessionID, ownerID: "owner-a", payload: {} },
          limit,
        ).catch(() => false),
      ),
    )
    expect(results.filter(Boolean)).toHaveLength(limit)
  })

  test("insertPendingLimited counts per session, not per directory", async () => {
    const sessionA = await createSession()
    const sessionB = await createSession()
    const ridA = id("que_quota")
    rowIDs.push(ridA)
    expect(
      await HitlStore.insertPendingLimited(
        { id: ridA, kind: "question", directory: DIRECTORY, userID: "", sessionID: sessionA, ownerID: "owner-a", payload: {} },
        1,
      ),
    ).toBe(true)
    const ridB = id("que_quota")
    rowIDs.push(ridB)
    expect(
      await HitlStore.insertPendingLimited(
        { id: ridB, kind: "question", directory: DIRECTORY, userID: "", sessionID: sessionB, ownerID: "owner-a", payload: {} },
        1,
      ),
    ).toBe(true)
  })

  test("casTransition: pending -> terminal returns updated row", async () => {
    const sessionID = await createSession()
    const rid = id("que_cas")
    rowIDs.push(rid)
    await insertRow({ id: rid, sessionID })
    const transition = { status: "replied" as const, result: { answers: [["yes"]] } }
    const outcome = await HitlStore.casTransition(rid, "question", DIRECTORY, transition)
    expect(outcome.updated?.status).toBe("replied")
    expect(outcome.updated?.result).toEqual({ answers: [["yes"]] })
    expect(outcome.current).toBeUndefined()
  })

  test("casTransition: identical repeat is idempotent (current, same=true)", async () => {
    const sessionID = await createSession()
    const rid = id("que_idem")
    rowIDs.push(rid)
    await insertRow({ id: rid, sessionID })
    const transition = { status: "replied" as const, result: { answers: [["yes"]] } }
    const first = await HitlStore.casTransition(rid, "question", DIRECTORY, transition)
    expect(first.updated).toBeDefined()
    const repeat = await HitlStore.casTransition(rid, "question", DIRECTORY, transition)
    expect(repeat.updated).toBeUndefined()
    expect(repeat.current?.status).toBe("replied")
    expect(HitlStore.sameTransition(repeat.current!, transition)).toBe(true)
  })

  test("casTransition: divergent decision is a conflict (current, same=false)", async () => {
    const sessionID = await createSession()
    const rid = id("que_conflict")
    rowIDs.push(rid)
    await insertRow({ id: rid, sessionID })
    await HitlStore.casTransition(rid, "question", DIRECTORY, { status: "rejected" })
    const late = await HitlStore.casTransition(rid, "question", DIRECTORY, {
      status: "replied",
      result: { answers: [["yes"]] },
    })
    expect(late.updated).toBeUndefined()
    expect(late.current?.status).toBe("rejected")
    expect(HitlStore.sameTransition(late.current!, { status: "replied", result: { answers: [["yes"]] } })).toBe(false)
  })

  test("casTransition: missing row returns empty outcome", async () => {
    const outcome = await HitlStore.casTransition(id("que_missing"), "question", DIRECTORY, { status: "rejected" })
    expect(outcome.updated).toBeUndefined()
    expect(outcome.current).toBeUndefined()
  })

  test("casTransition: kind and directory isolate the CAS", async () => {
    const sessionID = await createSession()
    const rid = id("que_iso")
    rowIDs.push(rid)
    await insertRow({ id: rid, sessionID })
    const wrongKind = await HitlStore.casTransition(rid, "permission", DIRECTORY, { status: "rejected" })
    expect(wrongKind.updated).toBeUndefined()
    expect(wrongKind.current).toBeUndefined()
    const wrongDirectory = await HitlStore.casTransition(rid, "question", "/tmp/hitl-other", { status: "rejected" })
    expect(wrongDirectory.updated).toBeUndefined()
    expect(wrongDirectory.current).toBeUndefined()
    const row = await fetchRow(rid)
    expect(row?.status).toBe("pending")
  })

  test("renewLease only touches rows owned by the same owner+directory", async () => {
    const sessionID = await createSession()
    const mine = id("que_lease_mine")
    const foreign = id("que_lease_foreign")
    const otherDir = id("que_lease_dir")
    rowIDs.push(mine, foreign, otherDir)
    await insertRow({ id: mine, sessionID, ownerID: "owner-a" })
    await insertRow({ id: foreign, sessionID, ownerID: "owner-b" })
    await insertRow({ id: otherDir, sessionID, ownerID: "owner-a", directory: "/tmp/hitl-other" })
    await HitlStore.renewLease([mine, foreign, otherDir], "owner-a", DIRECTORY)
    const mineRow = await fetchRow(mine)
    const foreignRow = await fetchRow(foreign)
    const otherDirRow = await fetchRow(otherDir)
    expect(Number(mineRow?.lease_until)).toBeGreaterThan(Date.now())
    expect(Number(foreignRow?.lease_until)).toBeLessThan(Date.now() + HitlStore.LEASE_TTL_MS)
    expect(Number(otherDirRow?.lease_until)).toBeLessThan(Date.now() + HitlStore.LEASE_TTL_MS)
  })

  test("changed only reports rows owned by the caller", async () => {
    const sessionID = await createSession()
    const mine = id("que_changed_mine")
    const foreign = id("que_changed_foreign")
    rowIDs.push(mine, foreign)
    await insertRow({ id: mine, sessionID, ownerID: "owner-a", status: "replied", result: { answers: [["yes"]] } })
    await insertRow({ id: foreign, sessionID, ownerID: "owner-b", status: "replied", result: { answers: [["no"]] } })
    const rows = await HitlStore.changed([mine, foreign], "owner-a", DIRECTORY)
    expect(rows.map((row) => row.id)).toEqual([mine])
    expect(rows[0]?.result).toEqual({ answers: [["yes"]] })
  })

  test("claimExpiredPending claims expired rows and skips live/terminal ones", async () => {
    const sessionID = await createSession()
    const expired = id("que_claim_expired")
    const live = id("que_claim_live")
    const terminal = id("que_claim_terminal")
    rowIDs.push(expired, live, terminal)
    await insertRow({ id: expired, sessionID, leaseUntil: Date.now() - 3 * HitlStore.SWEEP_GRACE_MS })
    await insertRow({ id: live, sessionID, leaseUntil: Date.now() + HitlStore.LEASE_TTL_MS })
    await insertRow({
      id: terminal,
      sessionID,
      status: "replied",
      leaseUntil: Date.now() - 3 * HitlStore.SWEEP_GRACE_MS,
    })

    const claimedExpired = await HitlStore.claimExpiredPending(expired, "question", DIRECTORY)
    expect(claimedExpired?.status).toBe("closed")
    expect(claimedExpired?.close_reason).toBe("instance-restart")

    expect(await HitlStore.claimExpiredPending(live, "question", DIRECTORY)).toBeUndefined()
    expect(await HitlStore.claimExpiredPending(terminal, "question", DIRECTORY)).toBeUndefined()
  })

  test("casCloseFinal only closes the matching terminal status", async () => {
    const sessionID = await createSession()
    const rid = id("que_final")
    rowIDs.push(rid)
    await insertRow({ id: rid, sessionID, status: "replied", result: { answers: [["yes"]] } })
    const mismatch = await HitlStore.casCloseFinal(rid, "question", DIRECTORY, "rejected", "decision-delivered")
    expect(mismatch).toHaveLength(0)
    const match = await HitlStore.casCloseFinal(rid, "question", DIRECTORY, "replied", "answered-delivered")
    expect(match).toHaveLength(1)
    expect((await fetchRow(rid))?.close_reason).toBe("answered-delivered")
  })

  test("retention removes old terminal rows in-directory, keeps pending and fresh rows", async () => {
    const sessionID = await createSession()
    const oldTerminal = id("que_ret_old")
    const freshTerminal = id("que_ret_fresh")
    const oldPending = id("que_ret_pending")
    rowIDs.push(oldTerminal, freshTerminal, oldPending)
    const now = Date.now()
    await insertRow({
      id: oldTerminal,
      sessionID,
      status: "closed",
      closeReason: "instance-restart",
      leaseUntil: now - HitlStore.RETENTION_MS - 60_000,
    })
    await fixtureDb!.unsafe(`UPDATE hitl_request SET time_updated = $1 WHERE id = $2`, [
      now - HitlStore.RETENTION_MS - 60_000,
      oldTerminal,
    ])
    await insertRow({ id: freshTerminal, sessionID, status: "closed", closeReason: "instance-restart" })
    await insertRow({
      id: oldPending,
      sessionID,
      status: "pending",
      leaseUntil: now - HitlStore.RETENTION_MS - 60_000,
    })
    await fixtureDb!.unsafe(`UPDATE hitl_request SET time_updated = $1 WHERE id = $2`, [
      now - HitlStore.RETENTION_MS - 60_000,
      oldPending,
    ])

    await HitlStore.retention(DIRECTORY)
    expect(await fetchRow(oldTerminal)).toBeUndefined()
    expect((await fetchRow(freshTerminal))?.status).toBe("closed")
    expect((await fetchRow(oldPending))?.status).toBe("pending")
  })
test("listPending scopes rows by requesting user", async () => {
    const sessionID = await createSession()
    const mine = id("que_iso_mine")
    const theirs = id("que_iso_theirs")
    const anon = id("que_iso_anon")
    rowIDs.push(mine, theirs, anon)
    await insertRow({ id: mine, sessionID, userID: "user-a" })
    await insertRow({ id: theirs, sessionID, userID: "user-b" })
    await insertRow({ id: anon, sessionID, userID: "" })

    const forA = await HitlStore.listPending("question", DIRECTORY, "user-a")
    expect(forA.map((row) => row.id)).toEqual([mine])
    const forB = await HitlStore.listPending("question", DIRECTORY, "user-b")
    expect(forB.map((row) => row.id)).toEqual([theirs])
    const forAnonymous = await HitlStore.listPending("question", DIRECTORY, "")
    expect(forAnonymous.map((row) => row.id)).toEqual([anon])
  })

  test("casTransition rejects cross-user replies but keeps internal salvage unfiltered", async () => {
    const sessionID = await createSession()
    const theirs = id("que_iso_cas")
    rowIDs.push(theirs)
    await insertRow({ id: theirs, sessionID, userID: "user-b" })

    // 跨用户回复：与不存在同语义（返回空 outcome，调用方映射 NotFound，防枚举）
    const blocked = await HitlStore.casTransition(theirs, "question", DIRECTORY, { status: "replied" }, "user-a")
    expect(blocked.updated).toBeUndefined()
    expect(blocked.current).toBeUndefined()
    expect((await fetchRow(theirs))?.status).toBe("pending")

    // 内部善后（不传 userID）仍可处理任意归属的行
    const salvaged = await HitlStore.casTransition(theirs, "question", DIRECTORY, {
      status: "closed",
      closeReason: "instance-restart",
    })
    expect(salvaged.updated?.status).toBe("closed")

    // 归属校验不破坏同用户正常回复
    const okRow = id("que_iso_ok")
    rowIDs.push(okRow)
    await insertRow({ id: okRow, sessionID, userID: "user-a" })
    const done = await HitlStore.casTransition(okRow, "question", DIRECTORY, { status: "replied" }, "user-a")
    expect(done.updated?.status).toBe("replied")
  })
})
