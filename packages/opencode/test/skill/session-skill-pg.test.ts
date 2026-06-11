import { beforeAll, beforeEach, afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { Database, eq } from "../../src/storage/db"
import { Bus } from "../../src/bus"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionSkill } from "../../src/skill/session-skill"
import { SessionSkillTable } from "../../src/skill/skill.pg"
import type { SessionID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"

const DB_URL = process.env.OPENCODE_DATABASE_URL
if (!DB_URL) {
  console.log("跳过 session-skill PG 测试：未设置 OPENCODE_DATABASE_URL")
  process.exit(0)
}

const runtime = ManagedRuntime.make(Layer.mergeAll(SessionSkill.layer, Session.defaultLayer, Bus.layer))
const db = Database.Client()

async function cleanup(sessionID: string) {
  await db.delete(SessionSkillTable).where(eq(SessionSkillTable.session_id, sessionID)).run()
}

function run<A>(effect: Effect.Effect<A, unknown, SessionSkill.Service | Session.Service | Bus.Service>) {
  return runtime.runPromise(effect)
}

describe("SessionSkill PG", () => {
  const sessions: { [key: string]: SessionID } = {}

  beforeAll(async () => {
    await Database.initialize()
  })

  afterEach(async () => {
    for (const id of Object.keys(sessions)) {
      await cleanup(id)
      await run(Session.Service.use((svc) => svc.remove(sessions[id]))).catch(() => undefined)
      delete sessions[id]
    }
  })

  async function make() {
    const tmp = await tmpdir({ git: true })
    const session = await Instance.provide({
      directory: tmp.path,
      fn: () => run(Session.Service.use((svc) => svc.create({ title: "session skill test" }))),
    })
    sessions[session.id] = session.id
    return { session, tmp }
  }

  test("upsert 插入并可通过 get/list 读回", async () => {
    const { session } = await make()
    const skill = await run(SessionSkill.Service.use((svc) =>
      svc.upsert(session.id, { name: "alpha", description: "Alpha skill", content: "# Alpha" }),
    ))

    expect(skill.session_id).toBe(session.id)
    expect(skill.name).toBe("alpha")
    expect(skill.resources).toEqual([])

    const got = await run(SessionSkill.Service.use((svc) => svc.get(session.id, "alpha")))
    expect(got!.content).toBe("# Alpha")

    const list = await run(SessionSkill.Service.use((svc) => svc.list(session.id)))
    expect(list.map((item) => item.name)).toEqual(["alpha"])
  })

  test("upsert 支持 resources jsonb", async () => {
    const { session } = await make()
    const skill = await run(SessionSkill.Service.use((svc) =>
      svc.upsert(session.id, {
        name: "bundle",
        description: "Bundle skill",
        content: "# Bundle",
        resources: [
          { path: "references/guide.md", type: "doc", content: "Guide" },
          { path: "templates/run.sh", type: "template", content: "#!/bin/sh\necho ok" },
        ],
      }),
    ))

    expect(skill.resources.map((item) => item.path)).toEqual(["references/guide.md", "templates/run.sh"])
    const got = await run(SessionSkill.Service.use((svc) => svc.get(session.id, "bundle")))
    expect(got!.resources[1].content).toContain("echo ok")
  })

  test("upsert 同名 skill 会更新而不是重复插入", async () => {
    const { session } = await make()
    await run(SessionSkill.Service.use((svc) =>
      svc.upsert(session.id, { name: "alpha", description: "old", content: "old" }),
    ))
    const updated = await run(SessionSkill.Service.use((svc) =>
      svc.upsert(session.id, { name: "alpha", description: "new", content: "new" }),
    ))

    expect(updated.description).toBe("new")
    expect(updated.content).toBe("new")
    const list = await run(SessionSkill.Service.use((svc) => svc.list(session.id)))
    expect(list.length).toBe(1)
  })

  test("不同 session 互相隔离", async () => {
    const a = await make()
    const b = await make()
    await run(SessionSkill.Service.use((svc) =>
      svc.upsert(a.session.id, { name: "alpha", description: "A", content: "A" }),
    ))
    await run(SessionSkill.Service.use((svc) =>
      svc.upsert(b.session.id, { name: "alpha", description: "B", content: "B" }),
    ))

    expect((await run(SessionSkill.Service.use((svc) => svc.get(a.session.id, "alpha"))))!.content).toBe("A")
    expect((await run(SessionSkill.Service.use((svc) => svc.get(b.session.id, "alpha"))))!.content).toBe("B")
  })

  test("remove 和 removeAll 清理 session skills", async () => {
    const { session } = await make()
    await run(SessionSkill.Service.use((svc) =>
      svc.upsert(session.id, { name: "alpha", description: "A", content: "A" }),
    ))
    await run(SessionSkill.Service.use((svc) =>
      svc.upsert(session.id, { name: "beta", description: "B", content: "B" }),
    ))

    await run(SessionSkill.Service.use((svc) => svc.remove(session.id, "alpha")))
    expect(await run(SessionSkill.Service.use((svc) => svc.get(session.id, "alpha")))).toBeUndefined()
    expect((await run(SessionSkill.Service.use((svc) => svc.list(session.id)))).length).toBe(1)

    await run(SessionSkill.Service.use((svc) => svc.removeAll(session.id)))
    expect(await run(SessionSkill.Service.use((svc) => svc.list(session.id)))).toEqual([])
  })

  test("删除 session 时 cascade 清理 session skills", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await run(Session.Service.use((svc) => svc.create({ title: "session skill cleanup" })))
        await run(SessionSkill.Service.use((svc) =>
          svc.upsert(session.id, { name: "cleanup", description: "Cleanup", content: "cleanup" }),
        ))
        expect((await run(SessionSkill.Service.use((svc) => svc.list(session.id)))).length).toBe(1)

        await run(Session.Service.use((svc) => svc.remove(session.id)))

        expect(await run(SessionSkill.Service.use((svc) => svc.list(session.id)))).toEqual([])
      },
    })
  })
})
