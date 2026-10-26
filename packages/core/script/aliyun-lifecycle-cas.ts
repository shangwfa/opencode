// Controlled idle-reap race probe; no billable cloud calls. Dedicated PG only.
import { mkdir, writeFile } from "node:fs/promises"
import { eq, inArray } from "drizzle-orm"
import { Effect } from "effect"
import { Project } from "@opencode/schema/project"
import { Session } from "@opencode/schema/session"
import { AbsolutePath } from "@opencode/schema/schema"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { Database } from "../src/database/database"
import { ProjectTable } from "../src/project/sql"
import { SessionTable, SessionExecutionGateTable, SandboxExecutionGateTable } from "../src/session/sql"
import { SandboxTable } from "../src/sandbox/sql"
import { SandboxConfig } from "../src/sandbox/config"
import { make } from "../src/sandbox/aliyun/provider"
import type { Api, Remote } from "../src/sandbox/aliyun/client"

if (!process.env.OPENCODE_DATABASE_URL?.endsWith("-cas-test")) throw new Error("需要独立 -cas-test 数据库")
const report: Record<string, unknown> = { passed: false, mode: "fake cloud + real PG", assertion: "刷新已选中的空闲候选后不得回收" }
const run = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const ids = [Session.ID.create(), Session.ID.create()]
  yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/workspace"), sandboxes: [] }).onConflictDoNothing().run()
  for (const id of ids) yield* db.insert(SessionTable).values({ id, project_id: Project.ID.global, slug: id, directory: "/workspace", version: "cas-probe" }).run()
  yield* Effect.addFinalizer(() => Effect.gen(function* () {
    yield* db.delete(SessionExecutionGateTable).where(inArray(SessionExecutionGateTable.session_id, ids)).run()
    yield* db.delete(SandboxExecutionGateTable).where(inArray(SandboxExecutionGateTable.root_session_id, ids)).run()
    yield* db.delete(SandboxTable).where(inArray(SandboxTable.session_id, ids)).run()
    yield* db.delete(SessionTable).where(inArray(SessionTable.id, ids)).run()
  }).pipe(Effect.orDie))
  let enter!: () => void
  let unblock!: () => void
  const entered = new Promise<void>((resolve) => { enter = resolve })
  const blocked = new Promise<void>((resolve) => { unblock = resolve })
  let pause = false
  const killed: string[] = []
  const remote = (id: string): Remote => ({ id, token: "fake-token",
    start: async () => ({ pid: 1, wait: async () => ({ exitCode: 0 }) }), killCommand: async () => true,
    listCommands: async () => [],
    snapshot: async () => { throw new Error("本用例不创建快照") }, extend: async () => {},
    stat: async () => ({ size: 0 }), read: async () => new Uint8Array(), write: async () => {},
    mkdir: async () => {}, remove: async () => {}, list: async () => [],
  })
  const api: Api = {
    create: async (_template, options) => remote(`fake-${options.metadata?.opencode_session}`),
    connect: async (id) => remote(id),
    info: async (id) => {
      if (pause && id === `fake-${ids[0]}`) { enter(); await blocked }
      return { state: "running" }
    },
    find: async () => [], kill: async (id) => { killed.push(id); return true },
    snapshots: async () => [], deleteSnapshot: async () => true,
  }
  const provider = yield* make({ ...SandboxConfig.load(), enabled: true, provider: "aliyun", idleReapSeconds: 60,
    aliyun: { apiKey: "fake", apiUrl: "https://api.cas.invalid", domain: "cas.invalid", template: "fake", pauseEnabled: false, installRipgrep: false },
  }, api)
  // Row A pauses the sweep after its PG candidate read, before visiting row B.
  yield* provider.keepAlive(ids[0]!)
  yield* provider.boot(ids[0]!)
  yield* provider.boot(ids[1]!)
  yield* db.update(SandboxTable).set({ time_updated: 0 }).where(eq(SandboxTable.session_id, ids[1]!)).run()
  pause = true
  console.log("CAS 探针 ▶ 等待扫描读取候选并进入可控屏障")
  yield* Effect.tryPromise(() => entered).pipe(Effect.timeout(25000))
  try {
    const candidate = yield* db.select().from(SandboxTable).where(eq(SandboxTable.session_id, ids[1]!)).get()
    if (candidate?.state !== "running" || candidate.time_updated !== 0 || killed.length)
      return yield* Effect.fail(new Error("扫描顺序不满足屏障前置条件；本轮不能判定 CAS"))
    yield* provider.fileWrite(ids[1]!, "/workspace/refreshed.txt", "new activity")
    const refreshed = yield* db.select().from(SandboxTable).where(eq(SandboxTable.session_id, ids[1]!)).get()
    report.refreshed = { state: refreshed?.state, timeUpdated: refreshed?.time_updated }
    console.log("CAS 探针 ✓ 候选读取之后已通过真实 provider 文件接口刷新 PG")
  } finally { pause = false; unblock() }
  const until = Date.now() + 5000
  while (Date.now() < until && !killed.includes(`fake-${ids[1]}`)) yield* Effect.sleep("100 millis")
  const after = yield* db.select().from(SandboxTable).where(eq(SandboxTable.session_id, ids[1]!)).get()
  report.after = { state: after?.state, timeUpdated: after?.time_updated }
  report.killed = killed
  report.passed = after?.state === "running" && !killed.includes(`fake-${ids[1]}`)
  console.log(`CAS 探针 ${report.passed ? "✓ PASS" : "✗ FAIL：新活动候选仍被销毁"}`)
})
try {
  await Effect.runPromise(run.pipe(Effect.scoped, Effect.provide(AppNodeBuilder.build(Database.node))))
} catch (error) { report.error = error instanceof Error ? error.message : String(error) }
finally {
  const output = process.env.STRESS_OUT ?? "../../artifacts/aliyun-lifecycle-20261025/cas"
  await mkdir(output, { recursive: true })
  await writeFile(`${output}/result.json`, JSON.stringify(report, null, 2))
  if (!report.passed) process.exitCode = 1
}
