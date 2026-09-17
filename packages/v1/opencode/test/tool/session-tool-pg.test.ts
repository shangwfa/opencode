import { beforeAll, afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { Database } from "../../src/storage/db"
import { Bus } from "../../src/bus"
import { SessionTool } from "../../src/tool/session-tool"
import type { SessionID } from "../../src/session/schema"

const DB_URL = process.env.OPENCODE_DATABASE_URL
if (!DB_URL) {
  console.log("跳过 session-tool PG 测试：未设置 OPENCODE_DATABASE_URL")
  process.exit(0)
}

const runtime = ManagedRuntime.make(Layer.mergeAll(SessionTool.pgLayer, Bus.layer) as any)

let sql: any

async function insertSession(id: string) {
  const now = Date.now()
  await sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
    VALUES (${id}, ${"test-project"}, ${"test-" + id}, ${"/tmp"}, ${"test"}, ${"0.0.1"}, ${now}, ${now})`
}

async function cleanupSession(id: string) {
  await sql`DELETE FROM session WHERE id = ${id}`
}

function run<A>(effect: Effect.Effect<A, unknown, SessionTool.Service>) {
  return runtime.runPromise(effect)
}

const SAMPLE_CODE = `import { tool } from "@opencode-ai/plugin"

export default tool({
  description: "Query the project database",
  args: {
    query: tool.schema.string().describe("SQL query to execute"),
  },
  async execute(args) {
    return \`Executed: \${args.query}\`
  },
})`

describe("SessionTool PG", () => {
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
    const id = `ses_test_stl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    await insertSession(id)
    sessions.push(id)
    return id as SessionID
  }

  test("upsert 插入并可通过 get/list 读回", async () => {
    const sid = await makeSession()
    const tool = await run(SessionTool.Service.use((svc) =>
      svc.upsert(sid, { name: "db-query", description: "Database query", code: SAMPLE_CODE }),
    ))

    expect(tool.session_id).toBe(sid)
    expect(tool.name).toBe("db-query")
    expect(tool.description).toBe("Database query")
    expect(tool.code).toBe(SAMPLE_CODE)

    const got = await run(SessionTool.Service.use((svc) => svc.get(sid, "db-query")))
    expect(got!.code).toBe(SAMPLE_CODE)

    const list = await run(SessionTool.Service.use((svc) => svc.list(sid)))
    expect(list.map((t) => t.name)).toEqual(["db-query"])
  })

  test("upsert 同名 tool 会更新而不是重复插入", async () => {
    const sid = await makeSession()
    await run(SessionTool.Service.use((svc) =>
      svc.upsert(sid, { name: "upsert-tool", description: "v1", code: "// v1" }),
    ))
    const updated = await run(SessionTool.Service.use((svc) =>
      svc.upsert(sid, { name: "upsert-tool", description: "v2", code: "// v2" }),
    ))

    expect(updated.description).toBe("v2")
    expect(updated.code).toBe("// v2")
    const list = await run(SessionTool.Service.use((svc) => svc.list(sid)))
    expect(list.length).toBe(1)
  })

  test("不同 session 互相隔离", async () => {
    const sidA = await makeSession()
    const sidB = await makeSession()
    await run(SessionTool.Service.use((svc) =>
      svc.upsert(sidA, { name: "iso-tool", description: "A", code: "// A" }),
    ))
    await run(SessionTool.Service.use((svc) =>
      svc.upsert(sidB, { name: "iso-tool", description: "B", code: "// B" }),
    ))

    expect((await run(SessionTool.Service.use((svc) => svc.get(sidA, "iso-tool"))))!.code).toBe("// A")
    expect((await run(SessionTool.Service.use((svc) => svc.get(sidB, "iso-tool"))))!.code).toBe("// B")
  })

  test("remove 和 removeAll 清理 session tools", async () => {
    const sid = await makeSession()
    await run(SessionTool.Service.use((svc) =>
      svc.upsert(sid, { name: "alpha", description: "A", code: "// A" }),
    ))
    await run(SessionTool.Service.use((svc) =>
      svc.upsert(sid, { name: "beta", description: "B", code: "// B" }),
    ))

    await run(SessionTool.Service.use((svc) => svc.remove(sid, "alpha")))
    expect(await run(SessionTool.Service.use((svc) => svc.get(sid, "alpha")))).toBeUndefined()
    expect((await run(SessionTool.Service.use((svc) => svc.list(sid)))).length).toBe(1)

    await run(SessionTool.Service.use((svc) => svc.removeAll(sid)))
    expect(await run(SessionTool.Service.use((svc) => svc.list(sid)))).toEqual([])
  })

  test("删除 session 时 cascade 清理 session tools", async () => {
    const sid = await makeSession()
    await run(SessionTool.Service.use((svc) =>
      svc.upsert(sid, { name: "cascade-tool", description: "Cascade", code: "// cascade" }),
    ))
    expect((await run(SessionTool.Service.use((svc) => svc.list(sid)))).length).toBe(1)

    await cleanupSession(sid)
    sessions.splice(sessions.indexOf(sid), 1)

    expect(await run(SessionTool.Service.use((svc) => svc.list(sid as SessionID)))).toEqual([])
  })
})
