import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { Database as BunSqlite } from "bun:sqlite"
import { drizzle, type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import { PartTable } from "../../src/session/session.pg"
import { runningToolCondition, MONITORED_TOOLS } from "../../src/session/watchdog-sql"
import { ReadTool } from "../../src/tool/read"
import { WriteTool } from "../../src/tool/write"
import { EditTool } from "../../src/tool/edit"
import { ApplyPatchTool } from "../../src/tool/apply_patch"
import { GlobTool } from "../../src/tool/glob"
import { GrepTool } from "../../src/tool/grep"
import { ListTool } from "../../src/tool/ls"

const TIMEOUT_MS = 5 * 60 * 1000

let sqlite: BunSqlite
let db: SQLiteBunDatabase

function createTestDb(): [BunSqlite, SQLiteBunDatabase] {
  const client = new BunSqlite(":memory:")
  client.exec(`
    CREATE TABLE part (
      id text PRIMARY KEY,
      message_id text NOT NULL,
      session_id text NOT NULL,
      time_created integer NOT NULL,
      time_updated integer NOT NULL,
      data text NOT NULL
    )
  `)
  const handle = drizzle({ client })
  return [client, handle]
}

type ToolPartData = {
  type: "tool"
  tool: string
  callID: string
  state: { status: string; input: Record<string, unknown>; time: { start: number } }
}

function insertToolPart(id: string, tool: string, status: string, start: number) {
  const data: ToolPartData = {
    type: "tool",
    tool,
    callID: `call-${id}`,
    state: { status, input: {}, time: { start } },
  }
  sqlite.run(
    "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
    [id, "msg-fake", "ses-fake", start, start, JSON.stringify(data)],
  )
}

function insertTextPart(id: string) {
  sqlite.run(
    "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
    [id, "msg-fake", "ses-fake", 0, 0, JSON.stringify({ type: "text", text: "hello" })],
  )
}

function queryStuckIds(startBefore: number): string[] {
  return db
    .select({ id: PartTable.id })
    .from(PartTable)
    .where(runningToolCondition(startBefore))
    .all()
    .map((row) => row.id)
    .sort()
}

describe("SessionWatchdog runningToolCondition", () => {
  beforeEach(() => {
    ;[sqlite, db] = createTestDb()
  })

  afterEach(() => sqlite?.close())

  describe("whitelist filtering", () => {
    const NOW = 10_000_000

    test("matches all whitelisted file tools that are running and timed out", () => {
      const startBefore = NOW - TIMEOUT_MS
      const oldStart = NOW - TIMEOUT_MS - 1000

      for (const tool of ["read", "write", "edit", "apply_patch", "glob", "grep", "list"]) {
        insertToolPart(`p-${tool}`, tool, "running", oldStart)
      }

      expect(queryStuckIds(startBefore)).toEqual([
        "p-apply_patch",
        "p-edit",
        "p-glob",
        "p-grep",
        "p-list",
        "p-read",
        "p-write",
      ])
    })

    test("excludes non-whitelisted tools even when running and timed out", () => {
      const startBefore = NOW - TIMEOUT_MS
      const oldStart = NOW - TIMEOUT_MS - 1000

      insertToolPart("p-bash", "bash", "running", oldStart)
      insertToolPart("p-task", "task", "running", oldStart)
      insertToolPart("p-webfetch", "webfetch", "running", oldStart)
      insertToolPart("p-websearch", "websearch", "running", oldStart)
      insertToolPart("p-mcp", "mcp__server__tool", "running", oldStart)
      insertToolPart("p-lsp", "lsp", "running", oldStart)
      insertToolPart("p-ls", "ls", "running", oldStart)

      expect(queryStuckIds(startBefore)).toEqual([])
    })

    test("task subagent is never matched — the regression this whitelist fixes", () => {
      const startBefore = NOW - TIMEOUT_MS
      insertToolPart("p-long-task", "task", "running", NOW - TIMEOUT_MS - 60_000)

      expect(queryStuckIds(startBefore)).toEqual([])
    })
  })

  describe("status and timing filtering", () => {
    const NOW = 10_000_000

    test("excludes whitelisted tools that are running but not yet timed out", () => {
      const startBefore = NOW - TIMEOUT_MS
      insertToolPart("p-recent-read", "read", "running", NOW - 60_000)

      expect(queryStuckIds(startBefore)).toEqual([])
    })

    test("excludes whitelisted tools that completed even if they took long", () => {
      const startBefore = NOW - TIMEOUT_MS
      const oldStart = NOW - TIMEOUT_MS - 1000

      insertToolPart("p-done-read", "read", "completed", oldStart)
      insertToolPart("p-error-write", "write", "error", oldStart)

      expect(queryStuckIds(startBefore)).toEqual([])
    })

    test("excludes non-tool parts", () => {
      const startBefore = NOW - TIMEOUT_MS
      insertTextPart("p-text")
      expect(queryStuckIds(startBefore)).toEqual([])
    })

    test("excludes tool parts without callID", () => {
      const startBefore = NOW - TIMEOUT_MS
      sqlite.run(
        "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
        [
          "p-no-call",
          "msg-fake",
          "ses-fake",
          0,
          0,
          JSON.stringify({ type: "tool", tool: "read", state: { status: "running", time: { start: startBefore - 1 } } }),
        ],
      )
      expect(queryStuckIds(startBefore)).toEqual([])
    })

    test("boundary: start exactly at threshold is not stuck (strictly less-than)", () => {
      const startBefore = NOW - TIMEOUT_MS
      insertToolPart("p-exact", "read", "running", startBefore)
      expect(queryStuckIds(startBefore)).toEqual([])
    })

    test("boundary: start one ms before threshold is stuck", () => {
      const startBefore = NOW - TIMEOUT_MS
      insertToolPart("p-just-over", "read", "running", startBefore - 1)
      expect(queryStuckIds(startBefore)).toEqual(["p-just-over"])
    })
  })

  describe("mixed scenario", () => {
    test("only whitelisted + running + timed-out parts surface in a realistic mix", () => {
      const NOW = 10_000_000
      const startBefore = NOW - TIMEOUT_MS
      const old = NOW - TIMEOUT_MS - 1000

      insertToolPart("stuck-read", "read", "running", old)
      insertToolPart("stuck-edit", "edit", "running", old)
      insertToolPart("stuck-bash", "bash", "running", old)
      insertToolPart("stuck-task", "task", "running", old)
      insertToolPart("fresh-read", "read", "running", NOW - 10_000)
      insertToolPart("done-read", "read", "completed", old)
      insertToolPart("stuck-grep", "grep", "running", old)
      insertTextPart("stuck-text")

      expect(queryStuckIds(startBefore)).toEqual(["stuck-edit", "stuck-grep", "stuck-read"])
    })
  })
})

describe("MONITORED_TOOLS whitelist linkage", () => {
  test("every whitelisted tool id maps to a real registered Tool", () => {
    const whitelist: string[] = [...MONITORED_TOOLS]
    const registered: string[] = [ReadTool, WriteTool, EditTool, ApplyPatchTool, GlobTool, GrepTool, ListTool].map(
      (t) => t.id,
    )
    expect(whitelist.sort()).toEqual(registered.sort())
  })

  test("no MONITORED_TOOLS entry references a non-existent tool id", () => {
    const registered = new Set([ReadTool, WriteTool, EditTool, ApplyPatchTool, GlobTool, GrepTool, ListTool].map((t) => t.id))
    for (const tool of MONITORED_TOOLS) {
      expect(registered.has(tool)).toBe(true)
    }
  })
})
