import { beforeAll, afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { Database } from "../../src/storage/db"
import { Bus } from "../../src/bus"
import { SessionCommand } from "../../src/command/session-command"
import type { SessionID } from "../../src/session/schema"
import postgres from "postgres"

const DB_URL = process.env.OPENCODE_DATABASE_URL
if (!DB_URL) {
  console.log("跳过 session-command PG 测试：未设置 OPENCODE_DATABASE_URL")
  process.exit(0)
}

const runtime = ManagedRuntime.make(Layer.mergeAll(SessionCommand.pgLayer, Bus.layer) as any)

const sql = postgres(DB_URL!, { max: 5 })

const TEST_PROJECT_ID = "test-project-cmd"

async function ensureProject() {
  const now = Date.now()
  await sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
    VALUES (${TEST_PROJECT_ID}, ${"/tmp"}, ${now}, ${now}, ${"[]"}::jsonb)
    ON CONFLICT (id) DO NOTHING`
}

async function insertSession(id: string) {
  const now = Date.now()
  await ensureProject()
  await sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
    VALUES (${id}, ${TEST_PROJECT_ID}, ${"test-" + id}, ${"/tmp"}, ${"test"}, ${"0.0.1"}, ${now}, ${now})`
}

async function cleanupSession(id: string) {
  await sql`DELETE FROM session WHERE id = ${id}`
}

function run<A>(effect: Effect.Effect<A, unknown, SessionCommand.Service>) {
  return runtime.runPromise(effect)
}

const SAMPLE_TEMPLATE = `Run the full test suite with coverage report.

Focus on the failing tests: $ARGUMENTS`

describe("SessionCommand PG", () => {
  const sessions: string[] = []

  beforeAll(async () => {
    await Database.initialize()
  })

  afterEach(async () => {
    for (const id of sessions) {
      await cleanupSession(id)
    }
    sessions.length = 0
  })

  async function makeSession(): Promise<SessionID> {
    const id = `ses_test_scmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    await insertSession(id)
    sessions.push(id)
    return id as SessionID
  }

  test("upsert 插入并可通过 get/list 读回", async () => {
    const sid = await makeSession()
    const cmd = await run(
      SessionCommand.Service.use((svc) =>
        svc.upsert(sid, { name: "test", description: "Run tests", template: SAMPLE_TEMPLATE, agent: "build" }),
      ),
    )

    expect(cmd.session_id).toBe(sid)
    expect(cmd.name).toBe("test")
    expect(cmd.description).toBe("Run tests")
    expect(cmd.template).toBe(SAMPLE_TEMPLATE)
    expect(cmd.agent).toBe("build")

    const got = await run(SessionCommand.Service.use((svc) => svc.get(sid, "test")))
    expect(got!.template).toBe(SAMPLE_TEMPLATE)

    const list = await run(SessionCommand.Service.use((svc) => svc.list(sid)))
    expect(list.map((c) => c.name)).toEqual(["test"])
  })

  test("upsert 同名 command 会更新而不是重复插入", async () => {
    const sid = await makeSession()
    await run(
      SessionCommand.Service.use((svc) =>
        svc.upsert(sid, { name: "upsert-cmd", description: "v1", template: "// v1" }),
      ),
    )
    const updated = await run(
      SessionCommand.Service.use((svc) =>
        svc.upsert(sid, { name: "upsert-cmd", description: "v2", template: "// v2", subtask: true }),
      ),
    )

    expect(updated.description).toBe("v2")
    expect(updated.template).toBe("// v2")
    expect(updated.subtask).toBe(true)
    const list = await run(SessionCommand.Service.use((svc) => svc.list(sid)))
    expect(list.length).toBe(1)
  })

  test("不同 session 互相隔离", async () => {
    const sidA = await makeSession()
    const sidB = await makeSession()
    await run(
      SessionCommand.Service.use((svc) =>
        svc.upsert(sidA, { name: "iso-cmd", description: "A", template: "// A" }),
      ),
    )
    await run(
      SessionCommand.Service.use((svc) =>
        svc.upsert(sidB, { name: "iso-cmd", description: "B", template: "// B" }),
      ),
    )

    expect((await run(SessionCommand.Service.use((svc) => svc.get(sidA, "iso-cmd"))))!.template).toBe("// A")
    expect((await run(SessionCommand.Service.use((svc) => svc.get(sidB, "iso-cmd"))))!.template).toBe("// B")
  })

  test("remove 和 removeAll 清理 session commands", async () => {
    const sid = await makeSession()
    await run(SessionCommand.Service.use((svc) => svc.upsert(sid, { name: "alpha", template: "// A" })))
    await run(SessionCommand.Service.use((svc) => svc.upsert(sid, { name: "beta", template: "// B" })))

    await run(SessionCommand.Service.use((svc) => svc.remove(sid, "alpha")))
    expect(await run(SessionCommand.Service.use((svc) => svc.get(sid, "alpha")))).toBeUndefined()
    expect((await run(SessionCommand.Service.use((svc) => svc.list(sid)))).length).toBe(1)

    await run(SessionCommand.Service.use((svc) => svc.removeAll(sid)))
    expect(await run(SessionCommand.Service.use((svc) => svc.list(sid)))).toEqual([])
  })

  test("删除 session 时 cascade 清理 session commands", async () => {
    const sid = await makeSession()
    await run(
      SessionCommand.Service.use((svc) => svc.upsert(sid, { name: "cascade-cmd", template: "// cascade" })),
    )
    expect((await run(SessionCommand.Service.use((svc) => svc.list(sid)))).length).toBe(1)

    await cleanupSession(sid)
    sessions.splice(sessions.indexOf(sid), 1)

    expect(await run(SessionCommand.Service.use((svc) => svc.list(sid as SessionID)))).toEqual([])
  })
})
