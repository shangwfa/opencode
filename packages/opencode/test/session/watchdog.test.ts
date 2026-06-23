import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { Database as BunSqlite } from "bun:sqlite"
import { drizzle, type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import path from "path"
import { readdirSync, readFileSync } from "fs"
import { PartTable } from "../../src/session/session.sql"
import { runningToolCondition } from "../../src/session/watchdog-sql"

const TIMEOUT_MS = 5 * 60 * 1000

let sqlite: BunSqlite
let db: SQLiteBunDatabase

function createTestDb(): [BunSqlite, SQLiteBunDatabase] {
  const client = new BunSqlite(":memory:")
  const dir = path.join(import.meta.dirname, "../../migration")
  const entries = readdirSync(dir, { withFileTypes: true })
  const migrations = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      sql: readFileSync(path.join(dir, entry.name, "migration.sql"), "utf-8"),
      timestamp: Number(entry.name.split("_")[0]),
      name: entry.name,
    }))
    .sort((a, b) => a.timestamp - b.timestamp)
  const handle = drizzle({ client })
  migrate(handle, migrations)
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
  db.insert(PartTable).values({
    id,
    message_id: "msg-fake",
    session_id: "ses-fake",
    time_created: start,
    time_updated: start,
    data,
  } as any).run()
}

function insertTextPart(id: string) {
  db.insert(PartTable).values({
    id,
    message_id: "msg-fake",
    session_id: "ses-fake",
    time_created: 0,
    time_updated: 0,
    data: { type: "text", text: "hello" },
  } as any).run()
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

  afterEach(() => sqlite.close())

  describe("whitelist filtering", () => {
    const NOW = 10_000_000

    test("matches all whitelisted file tools that are running and timed out", () => {
      const startBefore = NOW - TIMEOUT_MS
      const oldStart = NOW - TIMEOUT_MS - 1000

      for (const tool of ["read", "write", "edit", "apply_patch", "glob", "grep", "ls"]) {
        insertToolPart(`p-${tool}`, tool, "running", oldStart)
      }

      expect(queryStuckIds(startBefore)).toEqual([
        "p-apply_patch",
        "p-edit",
        "p-glob",
        "p-grep",
        "p-ls",
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
