import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect, ManagedRuntime } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import postgres from "postgres"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { AppNodeBuilderV1 } from "../../src/effect/app-node-builder-v1"
import { queryExecLogsBySession, type ExecLog } from "../../src/session/exec-log"
import { ToolExecLog } from "../../src/session/tool-exec-log"
import { SessionID } from "../../src/session/schema"

Log.init({ print: false })

const DB_URL = process.env.OPENCODE_DATABASE_URL
const enabled = (() => {
  if (!DB_URL) return false
  const url = new URL(DB_URL)
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/opencode_test"
})()
const fixtureDb = DB_URL ? postgres(DB_URL) : undefined

const layer = AppNodeBuilderV1.build(LayerNode.group([EventV2Bridge.node, ToolExecLog.node]))

const sessionID = SessionID.make("ses_toolexeclog_test")
const sessionBID = SessionID.make("ses_toolexeclog_test_b")
const projectID = "tool-exec-log-test-project"
const now = Date.now()

type ToolState =
  | { status: "pending"; input: Record<string, unknown>; raw: string }
  | { status: "running"; input: Record<string, unknown>; title?: string; time: { start: number } }
  | {
      status: "completed"
      input: Record<string, unknown>
      output: string
      title: string
      metadata: Record<string, unknown>
      time: { start: number; end: number }
    }
  | { status: "error"; input: Record<string, unknown>; error: string; time: { start: number; end: number } }

const toolPart = (sid: string, callID: string, state: ToolState) => ({
  id: `prt_toolexeclog_${callID}${sid === sessionBID ? "_b" : ""}`,
  sessionID: sid,
  messageID: sid === sessionID ? "msg_toolexeclog_test" : "msg_toolexeclog_test_b",
  type: "tool",
  tool: "write",
  callID,
  state,
})

const publishPart = (part: ReturnType<typeof toolPart>) =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    yield* events.publish(SessionV1.Event.PartUpdated, {
      sessionID: part.sessionID,
      part,
      time: Date.now(),
    } as never)
  }) as Effect.Effect<void>

const commandOf = (row: ExecLog) => JSON.parse(row.command) as Record<string, unknown>

const rowsByCall = async (sid: string, callID: string) => {
  const rows = await queryExecLogsBySession(sid)
  return rows.filter((row) => commandOf(row).callID === callID)
}

const rowByCall = async (sid: string, callID: string) => (await rowsByCall(sid, callID))[0] ?? null

// The listener persists through a bounded background queue, so assertions must
// poll until the expected state lands instead of reading immediately.
const waitFor = async (sid: string, callID: string, pred: (row: ExecLog) => boolean, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const row = await rowByCall(sid, callID)
    if (row && pred(row)) return row
    if (Date.now() > deadline) return row
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function cleanup() {
  if (!fixtureDb) return
  await fixtureDb.unsafe(`DELETE FROM exec_log WHERE session_id = ANY($1)`, [[sessionID, sessionBID]])
  await fixtureDb.unsafe(`DELETE FROM session WHERE id = ANY($1)`, [[sessionID, sessionBID]])
  await fixtureDb.unsafe(`DELETE FROM project WHERE id = $1`, [projectID])
}

describe.skipIf(!enabled)("tool exec_log persistence (PG)", () => {
  beforeAll(async () => {
    if (!fixtureDb) return
    await cleanup()
    await fixtureDb.unsafe(
      `INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [projectID, "/tmp/tool-exec-log-test", now, now, "[]"],
    )
    for (const [sid, slug, title] of [
      [sessionID, "tool-exec-log-test", "Tool exec log test"],
      [sessionBID, "tool-exec-log-test-b", "Tool exec log test B"],
    ] as const) {
      await fixtureDb.unsafe(
        `INSERT INTO session (
          id, project_id, directory, slug, title, version, time_created, time_updated,
          cost, tokens_input, tokens_output, tokens_reasoning
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, 0, 0, 0)`,
        [sid, projectID, "/tmp/tool-exec-log-test", slug, title, "test", now, now],
      )
    }
  })

  afterAll(async () => {
    await cleanup()
    await fixtureDb?.end()
  })

  const runtime = ManagedRuntime.make(layer)

  test("tool part lifecycle lands in exec_log with running → completed", async () => {
    const callID = "call_lifecycle"
    const start = Date.now()

    await runtime.runPromise(publishPart(toolPart(sessionID, callID, { status: "pending", input: {}, raw: "" })))
    const running = await waitFor(sessionID, callID, (row) => row.status === "running")
    expect(running).not.toBeNull()
    expect(running!.source).toBe("tool-call")
    expect(running!.time_finished).toBeNull()
    expect(commandOf(running!)).toMatchObject({ tool: "write", callID, partID: `prt_toolexeclog_${callID}` })
    expect(commandOf(running!).input).toBeUndefined()

    await runtime.runPromise(
      publishPart(
        toolPart(sessionID, callID, {
          status: "running",
          input: { filePath: "/workspace/a.vue", content: "hello" },
          time: { start },
        }),
      ),
    )
    const called = await waitFor(
      sessionID,
      callID,
      (row) => (commandOf(row).input as Record<string, unknown>)?.content === "hello",
    )
    expect(called!.status).toBe("running")

    const end = Date.now()
    await runtime.runPromise(
      publishPart(
        toolPart(sessionID, callID, {
          status: "completed",
          input: { filePath: "/workspace/a.vue", content: "hello" },
          output: "Wrote file successfully.",
          title: "a.vue",
          metadata: {},
          time: { start, end },
        }),
      ),
    )
    const done = await waitFor(sessionID, callID, (row) => row.status === "completed")
    expect(done!.time_finished).toBe(end)
    // Settled rows keep the last running command (input survives settlement).
    expect((commandOf(done).input as Record<string, unknown>)?.content).toBe("hello")
  })

  test("error tool part records failed with error text", async () => {
    const callID = "call_failed"
    const start = Date.now()
    const end = start + 100

    await runtime.runPromise(publishPart(toolPart(sessionID, callID, { status: "pending", input: {}, raw: "" })))
    await runtime.runPromise(
      publishPart(toolPart(sessionID, callID, { status: "error", input: {}, error: "sandbox exploded", time: { start, end } })),
    )

    const row = await waitFor(sessionID, callID, (item) => item.status === "failed")
    expect(row!.error).toBe("sandbox exploded")
    expect(row!.time_finished).toBe(end)
  })

  test("dropped argument stream stays running without time_finished (stuck-call signature)", async () => {
    const callID = "call_stuck"

    await runtime.runPromise(publishPart(toolPart(sessionID, callID, { status: "pending", input: {}, raw: "" })))

    const stuck = await waitFor(sessionID, callID, (row) => row.status === "running")
    expect(stuck).not.toBeNull()
    expect(stuck!.time_finished).toBeNull()
    expect(commandOf(stuck!).tool).toBe("write")
  })

  test("duplicate pending events are idempotent (single row kept)", async () => {
    const callID = "call_dup"

    await runtime.runPromise(publishPart(toolPart(sessionID, callID, { status: "pending", input: {}, raw: "" })))
    await runtime.runPromise(publishPart(toolPart(sessionID, callID, { status: "pending", input: {}, raw: "" })))
    await waitFor(sessionID, callID, (row) => row.status === "running")
    await new Promise((resolve) => setTimeout(resolve, 100))

    const rows = await rowsByCall(sessionID, callID)
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe("running")
  })

  test("terminal events without a prior pending event recover a settled row", async () => {
    const end = Date.now()

    await runtime.runPromise(
      publishPart(
        toolPart(sessionID, "call_recovered", {
          status: "completed",
          input: { filePath: "/workspace/r.vue" },
          output: "ok",
          title: "r.vue",
          metadata: {},
          time: { start: end - 10, end },
        }),
      ),
    )

    const row = await waitFor(sessionID, "call_recovered", (item) => item.status === "completed")
    expect(row).not.toBeNull()
    expect(row!.time_finished).toBe(end)
    expect(commandOf(row!).tool).toBe("write")
  })

  test("same callID reused by another session never crosses session rows", async () => {
    const callID = "call_shared"
    const start = Date.now()

    await runtime.runPromise(publishPart(toolPart(sessionID, callID, { status: "pending", input: {}, raw: "" })))
    await runtime.runPromise(
      publishPart(
        toolPart(sessionID, callID, {
          status: "running",
          input: { filePath: "/workspace/a.vue", content: "session-a" },
          time: { start },
        }),
      ),
    )
    const end = Date.now()
    await runtime.runPromise(
      publishPart(
        toolPart(sessionID, callID, {
          status: "completed",
          input: { filePath: "/workspace/a.vue", content: "session-a" },
          output: "done a",
          title: "a.vue",
          metadata: {},
          time: { start, end },
        }),
      ),
    )

    await runtime.runPromise(publishPart(toolPart(sessionBID, callID, { status: "pending", input: {}, raw: "" })))
    await runtime.runPromise(
      publishPart(
        toolPart(sessionBID, callID, {
          status: "running",
          input: { filePath: "/workspace/b.vue", content: "session-b" },
          time: { start: end + 1 },
        }),
      ),
    )

    // Wait for B first: the queue is ordered, so once B's row exists A's row
    // has already been through its full lifecycle.
    const rowB = await waitFor(
      sessionBID,
      callID,
      (row) => (commandOf(row).input as Record<string, unknown>)?.content === "session-b",
    )
    expect(rowB).not.toBeNull()
    expect(rowB!.session_id).toBe(sessionBID)
    expect(rowB!.status).toBe("running")

    const rowA = await waitFor(sessionID, callID, (row) => row.status === "completed")
    expect(rowA).not.toBeNull()
    expect(rowA!.session_id).toBe(sessionID)
    expect((commandOf(rowA).input as Record<string, unknown>)?.content).toBe("session-a")
  })

  test("late terminal event cannot flip a settled failure", async () => {
    const callID = "call_monotonic"
    const start = Date.now()
    const failEnd = start + 30

    await runtime.runPromise(publishPart(toolPart(sessionID, callID, { status: "pending", input: {}, raw: "" })))
    await runtime.runPromise(
      publishPart(toolPart(sessionID, callID, { status: "error", input: {}, error: "sandbox exploded", time: { start, end: failEnd } })),
    )
    // Late/duplicated terminal event arriving after the row already settled as failed.
    await runtime.runPromise(
      publishPart(
        toolPart(sessionID, callID, {
          status: "completed",
          input: {},
          output: "should not win",
          title: "late",
          metadata: {},
          time: { start, end: failEnd + 5 },
        }),
      ),
    )

    // Wait for the late event to be consumed too, then assert it was a no-op.
    await waitFor(sessionID, callID, (row) => row.status === "failed")
    await new Promise((resolve) => setTimeout(resolve, 150))
    const row = await rowByCall(sessionID, callID)
    expect(row!.status).toBe("failed")
    expect(row!.error).toBe("sandbox exploded")
    expect(row!.time_finished).toBe(failEnd)
  })

  test("running → error keeps called input and settles with error", async () => {
    const callID = "call_called_failed"
    const start = Date.now()
    const end = start + 50

    await runtime.runPromise(publishPart(toolPart(sessionID, callID, { status: "pending", input: {}, raw: "" })))
    await runtime.runPromise(
      publishPart(
        toolPart(sessionID, callID, { status: "running", input: { filePath: "/workspace/b.vue", content: "data" }, time: { start } }),
      ),
    )
    await runtime.runPromise(
      publishPart(
        toolPart(sessionID, callID, { status: "error", input: { filePath: "/workspace/b.vue" }, error: "Write timed out", time: { start, end } }),
      ),
    )

    const row = await waitFor(sessionID, callID, (item) => item.status === "failed")
    expect(row!.error).toBe("Write timed out")
    expect(row!.time_finished).toBe(end)
    expect((commandOf(row).input as Record<string, unknown>)?.filePath).toBe("/workspace/b.vue")
  })

  test("oversized tool input is truncated in command payload", async () => {
    const callID = "call_biginput"

    await runtime.runPromise(publishPart(toolPart(sessionID, callID, { status: "pending", input: {}, raw: "" })))
    await runtime.runPromise(
      publishPart(
        toolPart(sessionID, callID, {
          status: "running",
          input: { filePath: "/big.txt", content: "x".repeat(20_000) },
          time: { start: Date.now() },
        }),
      ),
    )

    const row = await waitFor(
      sessionID,
      callID,
      (item) => typeof (commandOf(item).input as Record<string, unknown> | undefined)?.truncated === "string",
    )
    const truncated = (commandOf(row!).input as { truncated: string }).truncated
    expect(truncated.endsWith("...[truncated]")).toBe(true)
    expect(truncated.length).toBeLessThanOrEqual(8192 + "...[truncated]".length)
  })

  test("non-tool parts never create exec_log rows", async () => {
    const before = (await queryExecLogsBySession(sessionID)).length

    await runtime.runPromise(
      Effect.gen(function* () {
        const events = yield* EventV2Bridge.Service
        yield* events.publish(SessionV1.Event.PartUpdated, {
          sessionID,
          part: {
            id: "prt_toolexeclog_text",
            sessionID,
            messageID: "msg_toolexeclog_test",
            type: "text",
            text: "hello",
          },
          time: Date.now(),
        } as never)
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 150))

    expect((await queryExecLogsBySession(sessionID)).length).toBe(before)
  })
})
