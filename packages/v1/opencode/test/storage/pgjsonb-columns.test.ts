// pgJsonb 列读写回归（PG-gated）：逐表验证 jsonb 列经 drizzle 读出为解析后的
// 对象/数组（而非 raw 字符串），且 default 值生效——钉住 storage/schema.pg.ts
// 的 pgJsonb customType 契约（驱动层返回 raw string，由列解码器 parse）。
// 需要本地测试库：
//   OPENCODE_DATABASE_URL=postgresql://local@127.0.0.1:15432/opencode_test bun test test/storage/pgjsonb-columns.test.ts
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import postgres from "postgres"
import { eq, like } from "drizzle-orm"
import { Database } from "../../src/storage/db"
import { SessionTable } from "../../src/session/session.pg"
import { SessionAgentTable } from "../../src/agent/agent.pg"
import { SessionSkillTable } from "../../src/skill/skill.pg"
import { SessionMcpTable } from "../../src/mcp/session-mcp.pg"
import { SessionCommandTable } from "../../src/command/session-command.pg"
import { SessionGoalTable } from "../../src/session/goal.pg"
import { ProjectTable } from "../../src/project/project.pg"
import { AuthTable } from "../../src/auth/auth.pg"
import { WorkspaceTable } from "../../src/control-plane/workspace.pg"
import { EventSequenceTable, EventTable } from "../../src/sync/event.pg"
import { ExecLogTable } from "../../src/session/exec-log"

const DB_URL = process.env.OPENCODE_DATABASE_URL
const enabled = (() => {
  if (!DB_URL) return false
  const url = new URL(DB_URL)
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/opencode_test"
})()
const db = enabled ? Database.Client() : undefined
const fixtureDb = DB_URL ? postgres(DB_URL as string) : undefined

const PREFIX = "pgjsonb"
const DIRECTORY = `/tmp/${PREFIX}-test`
let sequence = 0
const id = (tag: string) => `${PREFIX}_${tag}_${Date.now()}_${++sequence}`

async function insertSession(sessionID: string) {
  if (!fixtureDb) throw new Error("local PostgreSQL is required")
  const now = Date.now()
  await fixtureDb.unsafe(
    `INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO NOTHING`,
    [DIRECTORY, DIRECTORY, now, now, []],
  )
  await fixtureDb.unsafe(
    `INSERT INTO session (
       id, project_id, directory, slug, title, version, time_created, time_updated,
       cost, tokens_input, tokens_output, tokens_reasoning
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, 0, 0, 0)`,
    [sessionID, DIRECTORY, DIRECTORY, PREFIX, "pgJsonb test", "test", now, now],
  )
}

const now = () => Date.now()

describe.skipIf(!enabled)("pgJsonb column decode across schemas", () => {
  beforeAll(async () => {
    await Database.initialize()
    if (fixtureDb) {
      const now = Date.now()
      await fixtureDb.unsafe(
        `INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO NOTHING`,
        [DIRECTORY, DIRECTORY, now, now, []],
      )
    }
  })

  afterAll(async () => {
    if (!fixtureDb) return
    await fixtureDb.unsafe("DELETE FROM project WHERE id = $1", [DIRECTORY]).catch(() => {})
    await fixtureDb.end()
  })

  afterEach(async () => {
    if (!db) return
    await db
      .delete(ExecLogTable)
      .where(like(ExecLogTable.id, `${PREFIX}%`))
      .run()
      .catch(() => {})
    await db
      .delete(EventTable)
      .where(like(EventTable.id, `${PREFIX}%`))
      .run()
      .catch(() => {})
    await db
      .delete(EventSequenceTable)
      .where(like(EventSequenceTable.aggregate_id, `${PREFIX}%`))
      .run()
      .catch(() => {})
    await db
      .delete(AuthTable)
      .where(like(AuthTable.provider_id, `%`))
      .run()
      .catch(() => {})
    await db
      .delete(WorkspaceTable)
      .where(like(WorkspaceTable.id, `${PREFIX}%`))
      .run()
      .catch(() => {})
    await db
      .delete(SessionGoalTable)
      .where(like(SessionGoalTable.session_id, `${PREFIX}%`))
      .run()
      .catch(() => {})
    await db
      .delete(SessionCommandTable)
      .where(like(SessionCommandTable.id, `${PREFIX}%`))
      .run()
      .catch(() => {})
    await db
      .delete(SessionMcpTable)
      .where(like(SessionCommandTable.id, `${PREFIX}%`))
      .run()
      .catch(() => {})
    await db
      .delete(SessionSkillTable)
      .where(like(SessionSkillTable.id, `${PREFIX}%`))
      .run()
      .catch(() => {})
    await db
      .delete(SessionAgentTable)
      .where(like(SessionAgentTable.id, `${PREFIX}%`))
      .run()
      .catch(() => {})
    await db
      .delete(SessionTable)
      .where(like(SessionTable.id, `${PREFIX}%`))
      .run()
      .catch(() => {})
  })

  test("session: permission / metadata / model / sandbox decode as objects", async () => {
    const sessionID = id("ses")
    const permission = [{ permission: "bash", pattern: "rm *", action: "ask" as const }]
    const metadata = { origin: "pgjsonb-test", nested: { depth: 2 } }
    const model = { id: "m1", providerID: "p1" }
    const sandbox = { cpu: "1", memory: "1Gi" }
    await db!
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: DIRECTORY,
        directory: DIRECTORY,
        slug: PREFIX,
        title: "t",
        version: "test",
        permission,
        metadata,
        model,
        sandbox,
        time_created: now(),
        time_updated: now(),
      })
      .run()
    const rows = (await db!
      .select({
        permission: SessionTable.permission,
        metadata: SessionTable.metadata,
        model: SessionTable.model,
        sandbox: SessionTable.sandbox,
      })
      .from(SessionTable)
      .where(eq(SessionTable.id, sessionID as never))
      .limit(1)) as unknown as Array<{
      permission: unknown
      metadata: unknown
      model: unknown
      sandbox: unknown
    }>
    const row = rows[0]!
    expect(Array.isArray(row.permission)).toBe(true)
    expect(row.permission).toEqual(permission)
    expect(row.metadata).toEqual(metadata)
    expect(row.model).toEqual(model)
    expect(row.sandbox).toEqual(sandbox)
  })

  test("session_agents: defaults materialize as parsed values", async () => {
    const sessionID = id("ses")
    await insertSession(sessionID)
    const agentID = id("agent")
    await db!
      .insert(SessionAgentTable)
      .values({
        id: agentID,
        session_id: sessionID,
        name: "probe",
        mode: "all",
        time_created: now(),
        time_updated: now(),
      })
      .run()
    const rows = (await db!
      .select({
        permission: SessionAgentTable.permission,
        options: SessionAgentTable.options,
        model: SessionAgentTable.model,
      })
      .from(SessionAgentTable)
      .where(eq(SessionAgentTable.id, agentID))
      .limit(1)) as unknown as Array<{ permission: unknown; options: unknown; model: unknown }>
    const row = rows[0]!
    expect(Array.isArray(row.permission)).toBe(true)
    expect(row.permission).toEqual([])
    expect(row.options).toEqual({})
    expect(row.model).toBeNull()
  })

  test("session_skill / session_mcps / session_commands: typed arrays and objects", async () => {
    const sessionID = id("ses")
    await insertSession(sessionID)

    const skillID = id("skill")
    await db!
      .insert(SessionSkillTable)
      .values({
        id: skillID,
        session_id: sessionID,
        name: "probe-skill",
        description: "d",
        content: "c",
        resources: [{ path: "/tmp/x", kind: "file" }],
        time_created: now(),
        time_updated: now(),
      })
      .run()

    const mcpID = id("mcp")
    await db!
      .insert(SessionMcpTable)
      .values({
        id: mcpID,
        session_id: sessionID,
        name: "probe-mcp",
        type: "local",
        command: ["npx", "supergateway"],
        environment: { KEY: "value" },
        headers: { Authorization: "Bearer x" },
        enabled: true,
        time_created: now(),
        time_updated: now(),
      })
      .run()

    const commandID = id("cmd")
    await db!
      .insert(SessionCommandTable)
      .values({
        id: commandID,
        session_id: sessionID,
        name: "probe-cmd",
        template: "echo hi",
        hints: ["hint-a", "hint-b"],
        time_created: now(),
        time_updated: now(),
      })
      .run()

    const skillRow = (await db!
      .select({ resources: SessionSkillTable.resources })
      .from(SessionSkillTable)
      .where(eq(SessionSkillTable.id, skillID))
      .limit(1)) as unknown as Array<{ resources: unknown }>
    expect(Array.isArray(skillRow[0]!.resources)).toBe(true)
    expect(skillRow[0]!.resources).toEqual([{ path: "/tmp/x", kind: "file" }])

    const mcpRow = (await db!
      .select({
        command: SessionMcpTable.command,
        environment: SessionMcpTable.environment,
        headers: SessionMcpTable.headers,
        enabled: SessionMcpTable.enabled,
      })
      .from(SessionMcpTable)
      .where(eq(SessionMcpTable.id, mcpID))
      .limit(1)) as unknown as Array<{ command: unknown; environment: unknown; headers: unknown; enabled: unknown }>
    expect(mcpRow[0]!.command).toEqual(["npx", "supergateway"])
    expect(mcpRow[0]!.environment).toEqual({ KEY: "value" })
    expect(mcpRow[0]!.headers).toEqual({ Authorization: "Bearer x" })
    expect(mcpRow[0]!.enabled).toBe(true)

    const cmdRow = (await db!
      .select({ hints: SessionCommandTable.hints })
      .from(SessionCommandTable)
      .where(eq(SessionCommandTable.id, commandID))
      .limit(1)) as unknown as Array<{ hints: unknown }>
    expect(cmdRow[0]!.hints).toEqual(["hint-a", "hint-b"])
  })

  test("session_goal: nested verdict object round-trips", async () => {
    const sessionID = id("ses")
    await insertSession(sessionID)
    const verdict = { ok: true, impossible: false, reason: "all green", attempt: 2 }
    await db!
      .insert(SessionGoalTable)
      .values({
        session_id: sessionID,
        condition: "tests pass",
        react: 0,
        status: "active",
        last_verdict: verdict,
        time_created: now(),
        time_updated: now(),
      })
      .run()
    const rows = (await db!
      .select({ last_verdict: SessionGoalTable.last_verdict })
      .from(SessionGoalTable)
      .where(eq(SessionGoalTable.session_id, sessionID as never))
      .limit(1)) as unknown as Array<{ last_verdict: unknown }>
    expect(typeof rows[0]!.last_verdict).not.toBe("string")
    expect(rows[0]!.last_verdict).toEqual(verdict)
  })

  test("project / workspace / auth / event: top-level aggregates decode", async () => {
    const projectID = `${PREFIX}_proj_${Date.now()}`
    await db!
      .insert(ProjectTable)
      .values({
        id: projectID,
        worktree: DIRECTORY,
        sandboxes: ["sb_a", "sb_b"],
        commands: { start: "npm run dev" },
        time_created: now(),
        time_updated: now(),
      })
      .run()
    const projectRow = (await db!
      .select({ sandboxes: ProjectTable.sandboxes, commands: ProjectTable.commands })
      .from(ProjectTable)
      .where(eq(ProjectTable.id, projectID as never))
      .limit(1)) as unknown as Array<{ sandboxes: unknown; commands: unknown }>
    expect(projectRow[0]!.sandboxes).toEqual(["sb_a", "sb_b"])
    expect(projectRow[0]!.commands).toEqual({ start: "npm run dev" })

    const workspaceID = id("ws")
    await db!
      .insert(WorkspaceTable)
      .values({ id: workspaceID, type: "local", name: "w", extra: { tag: 1 }, project_id: projectID })
      .run()
    const workspaceRow = (await db!
      .select({ extra: WorkspaceTable.extra })
      .from(WorkspaceTable)
      .where(eq(WorkspaceTable.id, workspaceID as never))
      .limit(1)) as unknown as Array<{ extra: unknown }>
    expect(workspaceRow[0]!.extra).toEqual({ tag: 1 })

    const authID = id("auth")
    await db!
      .insert(AuthTable)
      .values({ provider_id: authID, type: "api", data: { token: "secret" }, time_created: now(), time_updated: now() })
      .run()
    const authRow = (await db!
      .select({ data: AuthTable.data })
      .from(AuthTable)
      .where(eq(AuthTable.provider_id, authID))
      .limit(1)) as unknown as Array<{ data: unknown }>
    expect(authRow[0]!.data).toEqual({ token: "secret" })

    const aggregateID = id("agg")
    await db!.insert(EventSequenceTable).values({ aggregate_id: aggregateID, seq: 1 }).run()
    const eventID = id("evt")
    await db!
      .insert(EventTable)
      .values({ id: eventID, aggregate_id: aggregateID, seq: 1, type: "probe", data: { a: [1, 2] } })
      .run()
    const eventRow = (await db!
      .select({ data: EventTable.data })
      .from(EventTable)
      .where(eq(EventTable.id, eventID))
      .limit(1)) as unknown as Array<{ data: unknown }>
    expect(eventRow[0]!.data).toEqual({ a: [1, 2] })

    await db!
      .delete(ProjectTable)
      .where(eq(ProjectTable.id, projectID as never))
      .run()
  })

  test("update path re-encodes objects (no double-encode)", async () => {
    const sessionID = id("ses")
    await insertSession(sessionID)
    const first = [{ permission: "bash", pattern: "*", action: "allow" as const }]
    const second = [{ permission: "edit", pattern: "*", action: "deny" as const }]
    await db!
      .update(SessionTable)
      .set({ permission: first, time_updated: now() })
      .where(eq(SessionTable.id, sessionID as never))
      .run()
    await db!
      .update(SessionTable)
      .set({ permission: second, time_updated: now() })
      .where(eq(SessionTable.id, sessionID as never))
      .run()
    const rows = (await db!
      .select({ permission: SessionTable.permission })
      .from(SessionTable)
      .where(eq(SessionTable.id, sessionID as never))
      .limit(1)) as unknown as Array<{ permission: unknown }>
    expect(rows[0]!.permission).toEqual(second)
  })
})
