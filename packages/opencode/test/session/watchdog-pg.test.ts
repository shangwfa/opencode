import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { Duration, Effect, Layer } from "effect"
import { EventV2 } from "@opencode-ai/core/event"
import postgres from "postgres"
import { eq } from "drizzle-orm"
import { Database } from "../../src/storage/db"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { SessionTools, transitionRunningTool } from "../../src/session/mark-timed-out"
import { MessageTable, PartTable, SessionTable } from "../../src/session/session.pg"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ToolExecution } from "../../src/session/tool-execution"
import { SessionWatchdog } from "../../src/session/watchdog"

const DB_URL = process.env.OPENCODE_DATABASE_URL
const enabled = (() => {
  if (!DB_URL) return false
  const url = new URL(DB_URL)
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/opencode_test"
})()
const db = Database.Client()
const fixtureDb = DB_URL ? postgres(DB_URL) : undefined
const sessions: SessionID[] = []
const PROJECT_ID = "watchdog-test-project"
let sequence = 0
type StoredToolData = {
  type: "tool"
  callID: string
  tool: string
  state: {
    status: string
    metadata?: {
      timeout?: boolean
      retry?: {
        strategy: string
        eligible: boolean
        attempt: number
        maxAttempts: number
        requiresVerification: boolean
      }
    }
    time?: { start: number; end?: number }
  }
}

function id(prefix: string) {
  sequence++
  return `${prefix}_${Date.now()}_${sequence}`
}

async function createSession() {
  const sessionID = SessionID.make(id("ses_watchdog"))
  const messageID = MessageID.make(id("msg_watchdog"))
  const now = Date.now()
  if (!fixtureDb) throw new Error("local PostgreSQL is required")
  await fixtureDb.unsafe(
    `INSERT INTO session (
      id, project_id, directory, slug, title, version, time_created, time_updated,
      cost, tokens_input, tokens_output, tokens_reasoning
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, 0, 0, 0)`,
    [sessionID, PROJECT_ID, "/tmp/watchdog-test", "watchdog-test", "Watchdog test", "test", now, now],
  )
  await fixtureDb.unsafe(
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ($1, $2, $3, $4, jsonb_build_object('role', 'assistant'))",
    [messageID, sessionID, now, now],
  )
  sessions.push(sessionID)
  return { sessionID, messageID }
}

async function insertRunning(input: {
  sessionID: SessionID
  messageID: MessageID
  callID: string
  tool: string
  start: number
}) {
  const partID = PartID.make(id("prt_watchdog"))
  if (!fixtureDb) throw new Error("local PostgreSQL is required")
  const inserted = await fixtureDb.unsafe(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
     VALUES (
       $1, $2, $3, $4, $5,
       jsonb_build_object(
         'type', 'tool', 'callID', $6::text, 'tool', $7::text,
         'state', jsonb_build_object(
           'status', 'running', 'input', '{}'::jsonb,
           'time', jsonb_build_object('start', $8::bigint)
         )
       )
     ) RETURNING id`,
    [
      partID,
      input.messageID,
      input.sessionID,
      input.start,
      input.start,
      input.callID,
      input.tool,
      input.start,
    ],
  )
  if (inserted[0]?.id !== partID) throw new Error(`part fixture insert failed: ${partID}`)
  return partID
}

async function partData(partID: PartID) {
  if (!fixtureDb) throw new Error("local PostgreSQL is required")
  const rows = await fixtureDb<{ data_text: string }[]>`SELECT data::text AS data_text FROM part WHERE id = ${partID}`
  if (!rows[0]) throw new Error(`part fixture not found: ${partID}`)
  const data = rows[0]?.data_text
  if (typeof data !== "string") throw new Error(`unexpected fixture row: ${JSON.stringify(rows[0])}`)
  return typeof data === "string" ? JSON.parse(data) as StoredToolData : undefined
}

describe.skipIf(!enabled)("SessionWatchdog PostgreSQL", () => {
  beforeAll(async () => {
    await Database.initialize()
    if (!fixtureDb) return
    const now = Date.now()
    await fixtureDb.unsafe(
      `INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [PROJECT_ID, "/tmp/watchdog-test", now, now, "[]"],
    )
  })

  afterAll(async () => {
    if (!fixtureDb) return
    await fixtureDb.unsafe("DELETE FROM project WHERE id = $1", [PROJECT_ID])
    await fixtureDb.end()
  })

  afterEach(async () => {
    for (const sessionID of sessions) await db.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run()
    sessions.length = 0
  })

  test("markTimedOut applies CAS, publishes an event, aborts execution, and enforces retry budget", async () => {
    const chat = await createSession()
    const events: unknown[] = []
    const publish: EventV2.Interface["publish"] = (definition, data) =>
      Effect.sync(() => {
        events.push(data)
        return { id: EventV2.ID.create(), type: definition.type, data } as EventV2.Payload<typeof definition>
      })
    const layer = SessionTools.layer.pipe(
      Layer.provide(Layer.mock(EventV2Bridge.Service, {
        publish,
      })),
    )
    const tools = ["read", "write", "edit"]

    for (const [index, tool] of tools.entries()) {
      const start = Date.now() - 10_000
      const callID = `call_retry_${index}`
      const partID = await insertRunning({ ...chat, callID, tool, start })
      const controller = new AbortController()
      const unregister = ToolExecution.register(chat.sessionID, callID, controller)
      const before = await partData(partID)
      if (before?.type !== "tool") throw new Error(`unexpected part data: ${JSON.stringify(before)}`)
      expect(before.state.status).toBe("running")
      expect(before.state.time?.start).toBe(start)
      const marked = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* SessionTools.Service
          return yield* service.markTimedOut({ partID, expectedStart: start, timeoutMs: 5_000 })
        }).pipe(Effect.provide(layer)),
      )
      unregister()

      expect(marked).toBe(true)
      expect(controller.signal.aborted).toBe(true)
      const data = await partData(partID)
      expect(data?.type).toBe("tool")
      if (data?.type !== "tool" || data.state.status !== "error") throw new Error("expected timed out tool part")
      expect(data.state.metadata?.timeout).toBe(true)
      expect(data.state.metadata?.retry).toEqual({
        strategy: "agent",
        eligible: index < 2,
        attempt: index + 1,
        maxAttempts: 2,
        requiresVerification: tool !== "read",
      })
    }

    expect(events).toHaveLength(3)
  }, 20_000)

  test("terminal transition is first-writer-wins", async () => {
    const chat = await createSession()
    const start = Date.now() - 1_000
    const partID = await insertRunning({ ...chat, callID: "call_transition", tool: "read", start })
    const completed = {
      id: partID,
      messageID: chat.messageID,
      sessionID: chat.sessionID,
      type: "tool" as const,
      callID: "call_transition",
      tool: "read",
      state: { status: "completed" as const, input: {}, output: "ok", title: "read", metadata: {}, time: { start, end: Date.now() } },
    }
    const failed = {
      ...completed,
      state: { status: "error" as const, input: {}, error: "late error", metadata: {}, time: { start, end: Date.now() } },
    }

    const before = await partData(partID)
    if (before?.type !== "tool") throw new Error(`unexpected part data: ${JSON.stringify(before)}`)
    expect(before.state.status).toBe("running")
    expect(before.state.time?.start).toBe(start)
    expect(await Effect.runPromise(transitionRunningTool(completed, start))).toBe(true)
    expect(await Effect.runPromise(transitionRunningTool(failed, start))).toBe(false)
    const data = await partData(partID)
    expect(data?.type === "tool" && data.state.status).toBe("completed")
  })

  test("scanOnce only marks executions owned by this process and session", async () => {
    const local = await createSession()
    const remote = await createSession()
    const start = Date.now() - 10_000
    const localPart = await insertRunning({ ...local, callID: "shared_call", tool: "read", start })
    await insertRunning({ ...remote, callID: "shared_call", tool: "read", start })
    const marked: PartID[] = []
    const unregister = ToolExecution.register(local.sessionID, "shared_call", new AbortController())
    const layer = SessionWatchdog.layerWithConfig({
      scanInterval: Duration.hours(1),
      initialDelay: Duration.hours(1),
      timeoutMs: 5_000,
    }).pipe(
      Layer.provide(Layer.mock(SessionTools.Service, {
        markTimedOut: (input) => Effect.sync(() => {
          marked.push(input.partID)
          return true
        }),
      })),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const watchdog = yield* SessionWatchdog.Service
        yield* watchdog.scanOnce
      }).pipe(Effect.scoped, Effect.provide(layer)),
    )
    unregister()

    expect(marked).toEqual([localPart])
  })
})
