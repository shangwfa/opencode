// HITL salvage 清扫三分支（PG-gated）：
//   过期 pending → part error + closed(instance-restart)
//   replied 未消费 → part completed 答案回填 + closed(answered-delivered)
//   rejected 未消费 → part error + closed(decision-delivered)
//   活租约不动；part 已终态不覆盖；part 缺失则事务回滚留待下轮。
// 需要本地测试库：
//   OPENCODE_DATABASE_URL=postgresql://local@127.0.0.1:15432/opencode_test bun test test/hitl/salvage.test.ts
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { EventV2 } from "@opencode-ai/core/event"
import postgres from "postgres"
import { eq } from "drizzle-orm"
import { Database } from "../../src/storage/db"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { HitlSalvage } from "../../src/hitl/salvage"
import { HitlStore } from "../../src/hitl/store"
import { HitlRequestTable } from "../../src/hitl/request.pg"
import { MessageTable, PartTable, SessionTable } from "../../src/session/session.pg"
import { MessageID, PartID, SessionID } from "../../src/session/schema"

const DB_URL = process.env.OPENCODE_DATABASE_URL
const enabled = (() => {
  if (!DB_URL) return false
  const url = new URL(DB_URL)
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/opencode_test"
})()
const db = enabled ? Database.Client() : undefined
const fixtureDb = DB_URL ? postgres(DB_URL as string) : undefined

const DIRECTORY = "/tmp/hitl-salvage-test"
const PROJECT_ID = "hitl-salvage-test-project"
let sequence = 0

const id = (prefix: string) => `${prefix}_${Date.now()}_${++sequence}`

const sessions: string[] = []
const rows: string[] = []

async function createChat() {
  if (!fixtureDb) throw new Error("local PostgreSQL is required")
  const sessionID = SessionID.make(id("ses_salvage"))
  const messageID = MessageID.make(id("msg_salvage"))
  const now = Date.now()
  await fixtureDb.unsafe(
    `INSERT INTO session (
       id, project_id, directory, slug, title, version, time_created, time_updated,
       cost, tokens_input, tokens_output, tokens_reasoning
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, 0, 0, 0)`,
    [sessionID, PROJECT_ID, DIRECTORY, "hitl-salvage-test", "HITL salvage test", "test", now, now],
  )
  await fixtureDb.unsafe(
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ($1, $2, $3, $4, $5)",
    [messageID, sessionID, now, now, { role: "assistant" }],
  )
  sessions.push(sessionID)
  return { sessionID, messageID }
}

async function insertToolPart(input: { messageID: string; sessionID: string; state: string; output?: string }) {
  if (!fixtureDb) throw new Error("local PostgreSQL is required")
  const partID = PartID.make(id("prt_salvage"))
  const now = Date.now()
  const data =
    input.state === "running"
      ? {
          type: "tool",
          callID: `call_${partID}`,
          tool: "question",
          state: { status: "running", input: {}, time: { start: now - 5_000 } },
        }
      : {
          type: "tool",
          callID: `call_${partID}`,
          tool: "question",
          state: {
            status: "completed",
            input: {},
            output: input.output ?? "done",
            title: "question",
            time: { start: now - 5_000, end: now },
          },
        }
  await fixtureDb.unsafe(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [partID, input.messageID, input.sessionID, now, now, data as never],
  )
  return { partID, callID: `call_${partID}` }
}

async function partState(partID: string) {
  if (!fixtureDb) throw new Error("local PostgreSQL is required")
  const result = await fixtureDb.unsafe("SELECT data::text AS data FROM part WHERE id = $1", [partID])
  const data = JSON.parse(result[0].data as string) as {
    state: { status: string; output?: string; error?: string; metadata?: Record<string, unknown> }
  }
  return data.state
}

type HitlFixture = {
  kind?: "question" | "permission"
  status?: "pending" | "replied" | "rejected"
  ownerID?: string
  sessionID: string
  tool?: { messageID: string; callID: string }
  result?: Record<string, unknown>
  expired?: boolean
}

async function insertHitl(input: HitlFixture) {
  if (!fixtureDb) throw new Error("local PostgreSQL is required")
  const rid = id(input.kind === "permission" ? "prm" : "que")
  const now = Date.now()
  await fixtureDb.unsafe(
    `INSERT INTO hitl_request (
       id, kind, directory, session_id, owner_id, status, payload, result, close_reason, lease_until, time_created, time_updated
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9, $10, $11)`,
    [
      rid,
      input.kind ?? "question",
      DIRECTORY,
      input.sessionID,
      input.ownerID ?? "owner-dead",
      input.status ?? "pending",
      { ...(input.tool ? { tool: input.tool } : {}) } as never,
      (input.result ?? null) as never,
      // expired=false keeps a live lease (now + TTL); expired=true is well
      // past the sweep grace so the row counts as owner-dead.
      input.expired === false ? now + HitlStore.LEASE_TTL_MS : now - 3 * 30_000,
      now,
      now,
    ],
  )
  rows.push(rid)
  return rid
}

// Direct import keeps fixture helpers close to their only usage.

const eventsLayer = (events: unknown[]) =>
  Layer.mock(EventV2Bridge.Service, {
    publish: ((definition: EventV2.Definition, data: unknown) =>
      Effect.sync(() => {
        events.push({ type: definition.type, data })
        return { id: EventV2.ID.create(), type: definition.type, data } as never
      })) as EventV2.Interface["publish"],
  })

const sweep = (kind: "question" | "permission", events: unknown[]) =>
  Effect.gen(function* () {
    const bridge = yield* EventV2Bridge.Service
    return yield* HitlSalvage.sweepKind(bridge, kind, DIRECTORY)
  }).pipe(Effect.provide(eventsLayer(events)))

const hitlRow = async (rid: string) => {
  const found = await db!.select().from(HitlRequestTable).where(eq(HitlRequestTable.id, rid)).limit(1).all()
  const row = found[0]
  if (!row) throw new Error(`hitl row not found: ${rid}`)
  const result = typeof row.result === "string" ? (JSON.parse(row.result) as Record<string, unknown>) : row.result
  return { status: row.status, closeReason: row.close_reason, result }
}

describe.skipIf(!enabled)("HITL salvage sweep (PG)", () => {
  beforeAll(async () => {
    await Database.initialize()
    if (!fixtureDb) return
    const now = Date.now()
    await fixtureDb.unsafe(
      `INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING`,
      [PROJECT_ID, DIRECTORY, now, now, []],
    )
  })

  afterAll(async () => {
    if (!fixtureDb) return
    await fixtureDb.unsafe("DELETE FROM project WHERE id = $1", [PROJECT_ID])
    await fixtureDb.end()
  })

  afterEach(async () => {
    for (const rid of rows)
      await db!
        .delete(HitlRequestTable)
        .where(eq(HitlRequestTable.id, rid as never))
        .run()
    for (const sid of sessions)
      await db!
        .delete(SessionTable)
        .where(eq(SessionTable.id, sid as never))
        .run()
    rows.length = 0
    sessions.length = 0
  })

  test("expired pending: part -> error, row closed(instance-restart), event published", async () => {
    const chat = await createChat()
    const part = await insertToolPart({ ...chat, state: "running" })
    const rid = await insertHitl({
      sessionID: chat.sessionID,
      tool: { messageID: chat.messageID, callID: part.callID },
      expired: true,
    })
    const events: unknown[] = []

    const stats = await Effect.runPromise(sweep("question", events))

    expect(stats.sweptPending).toBe(1)
    const state = await partState(part.partID)
    expect(state.status).toBe("error")
    expect(state.error).toContain("restarted")
    expect((state.metadata?.hitl as Record<string, unknown>)?.salvaged).toBe(true)
    const row = await hitlRow(rid)
    expect(row.status).toBe("closed")
    expect(row.closeReason).toBe("instance-restart")
    expect(events.filter((e) => (e as { type: string }).type === "message.part.updated")).toHaveLength(1)
  })

  test("answered-lost (replied, unconsumed): part -> completed with answer backfill, row archived", async () => {
    const chat = await createChat()
    const part = await insertToolPart({ ...chat, state: "running" })
    const rid = await insertHitl({
      sessionID: chat.sessionID,
      status: "replied",
      result: { answers: [["continue"]] },
      tool: { messageID: chat.messageID, callID: part.callID },
      expired: true,
    })
    const events: unknown[] = []

    const stats = await Effect.runPromise(sweep("question", events))

    expect(stats.answeredBackfilled).toBe(1)
    const state = await partState(part.partID)
    expect(state.status).toBe("completed")
    expect(state.output).toBe("User answered: continue")
    const row = await hitlRow(rid)
    expect(row.status).toBe("closed")
    expect(row.closeReason).toBe("answered-delivered")
    expect(events.filter((e) => (e as { type: string }).type === "message.part.updated")).toHaveLength(1)
  })

  test("rejected, unconsumed: part -> error, row closed(decision-delivered)", async () => {
    const chat = await createChat()
    const part = await insertToolPart({ ...chat, state: "running" })
    const rid = await insertHitl({
      kind: "permission",
      sessionID: chat.sessionID,
      status: "rejected",
      tool: { messageID: chat.messageID, callID: part.callID },
      expired: true,
    })
    const events: unknown[] = []

    const stats = await Effect.runPromise(sweep("permission", events))

    expect(stats.archivedFinal).toBeGreaterThanOrEqual(1)
    const state = await partState(part.partID)
    expect(state.status).toBe("error")
    expect(state.error).toBe("The user rejected this request.")
    const row = await hitlRow(rid)
    expect(row.status).toBe("closed")
    expect(row.closeReason).toBe("decision-delivered")
  })

  test("live lease rows are never swept", async () => {
    const chat = await createChat()
    const part = await insertToolPart({ ...chat, state: "running" })
    const rid = await insertHitl({
      sessionID: chat.sessionID,
      tool: { messageID: chat.messageID, callID: part.callID },
      expired: false,
    })
    const events: unknown[] = []

    const stats = await Effect.runPromise(sweep("question", events))

    expect(stats.sweptPending).toBe(0)
    const state = await partState(part.partID)
    expect(state.status).toBe("running")
    expect((await hitlRow(rid)).status).toBe("pending")
  })

  test("already-terminal part is not overwritten; row still archives", async () => {
    const chat = await createChat()
    const part = await insertToolPart({ ...chat, state: "completed", output: "original" })
    const rid = await insertHitl({
      sessionID: chat.sessionID,
      status: "replied",
      result: { answers: [["late"]] },
      tool: { messageID: chat.messageID, callID: part.callID },
      expired: true,
    })
    const events: unknown[] = []

    await Effect.runPromise(sweep("question", events))

    const state = await partState(part.partID)
    expect(state.status).toBe("completed")
    expect(state.output).toBe("original")
    const row = await hitlRow(rid)
    expect(row.status).toBe("closed")
    expect(row.closeReason).toBe("answered-delivered")
    expect(events).toHaveLength(0)
  })

  test("missing part rolls the archive back for the next sweep", async () => {
    const chat = await createChat()
    const rid = await insertHitl({
      sessionID: chat.sessionID,
      status: "replied",
      result: { answers: [["gone"]] },
      tool: { messageID: chat.messageID, callID: "call_missing" },
      expired: true,
    })
    const events: unknown[] = []

    await Effect.runPromise(sweep("question", events))

    const row = await hitlRow(rid)
    expect(row.status).toBe("replied")
    expect(row.closeReason).toBeNull()
  })
})
