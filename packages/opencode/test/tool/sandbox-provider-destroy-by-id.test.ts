/**
 * destroyById 单元测试（pgLayer）
 *
 * 验证按沙箱 ID 销毁的行为（POST /sandbox/:sandboxID/kill 的底层）：
 * - running 沙箱销毁后返回所属 sessionID（pvc 会话直接销毁）
 * - snapshot 会话：先发起快照并等 Ready，成功后才销毁源沙箱（顺序断言）
 * - snapshot 会话快照发起失败：沙箱保留待重试（无 DELETE），行保持 killed
 * - killed / destroyed / 不存在的 sandboxID 返回 null 且不产生副作用
 *
 * 运行方式：
 *   OPENCODE_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/opencode_test \
 *   bun test test/tool/sandbox-provider-destroy-by-id.test.ts
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import { eq, like } from "drizzle-orm"
import { Database } from "../../src/storage/db"
import { SandboxTable } from "../../src/tool/sandbox.pg"
import { SessionTable } from "../../src/session/session.pg"
import { SessionSnapshotTable } from "../../src/tool/session-snapshot.pg"
import { ProjectTable } from "../../src/project/project.pg"
import { SandboxProvider, SandboxConfig } from "../../src/tool/sandbox-provider"
import type { SessionID } from "../../src/session/schema"
import type { ProjectV2 } from "@opencode-ai/core/project"

const DB_URL = process.env.OPENCODE_DATABASE_URL
const enabled = (() => {
  if (!DB_URL) return false
  const url = new URL(DB_URL)
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/opencode_test"
})()

// 仅 PG 模式（enabled）下由 beforeAll 初始化，避免模块加载期误开 SQLite
let db: ReturnType<typeof Database.Client>
const requests: Array<{ method: string; path: string }> = []
const snapshotStartFails = new Set<string>()
const snapshotPollState = new Map<string, string>()

const lifecycle = Bun.serve({
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname
    requests.push({ method: request.method, path })
    if (request.method === "GET" && path === "/ping") return new Response("ok")
    if (request.method === "POST" && /^\/v1\/sandboxes\/[^/]+\/snapshots$/.test(path)) {
      const sandboxId = path.split("/")[3]
      if (snapshotStartFails.has(sandboxId)) {
        return Response.json({ code: "SNAPSHOT_FAILED", message: "simulated snapshot failure" }, { status: 500 })
      }
      return Response.json({
        id: `snap_${sandboxId}`,
        createdAt: new Date().toISOString(),
        status: { state: "Creating" },
      })
    }
    if (request.method === "GET" && /^\/v1\/snapshots\/[^/]+$/.test(path)) {
      const snapshotId = path.split("/")[3]
      const state = snapshotPollState.get(snapshotId) ?? "Ready"
      return Response.json({ id: snapshotId, createdAt: new Date().toISOString(), status: { state } })
    }
    if (request.method === "DELETE" && /^\/v1\/snapshots\/[^/]+$/.test(path)) return new Response(null, { status: 200 })
    if (request.method === "GET" && path === "/v1/snapshots") return Response.json({ items: [] })
    if (request.method === "GET" && path.includes("/endpoints/")) {
      return Response.json({ endpoint: new URL(request.url).host, headers: {} })
    }
    if (request.method === "DELETE" && path.startsWith("/v1/sandboxes/")) return new Response(null, { status: 200 })
    return Response.json({ code: "NOT_FOUND", message: "not found" }, { status: 404 })
  },
})

const config = SandboxConfig.Service.of({
  domain: lifecycle.url.host,
  protocol: "http",
  apiKey: "",
  useServerProxy: false,
  image: "fake",
  timeoutSeconds: 300,
  resourceLimits: { cpu: "1", memory: "2Gi" },
  volumeType: "none" as const,
  pvcClaimName: "",
  snapshotImage: "fake-snap",
  snapshotTtlMs: 7 * 86400_000,
  snapshotWaitMs: 15_000,
  idleKillMs: 3_600_000,
  idleReapMs: 3_600_000,
  idleReapIntervalMs: 3_600_000,
  maxTtlSeconds: 3600,
  packageCacheMount: "/cache",
  cleanupOnScopeExit: false,
})
const configLayer = Layer.succeed(SandboxConfig.Service, config)

const PROJ_ID = "proj_dbid_test" as ProjectV2.ID
const SID_PREFIX = "ses_dbid_"
const sid = (s: string) => s as SessionID

let scope: Scope.Scope | undefined
let context: Context.Context<SandboxProvider.Service> | undefined

const svc = () => Context.get(context!, SandboxProvider.Service)

async function insertFixtures(name: string, opts: { persistMode: "pvc" | "snapshot"; host: string; state?: "running" | "killed" | "destroyed" }) {
  const sessionID = sid(`${SID_PREFIX}${name}`)
  await db.insert(SandboxTable).values({
    id: `sb_${name}`,
    session_id: sessionID,
    host: opts.host,
    state: opts.state ?? "running",
    keep_alive: false,
    command_session_id: null,
    time_created: Date.now(),
    time_updated: Date.now(),
  }).onConflictDoNothing().run()
  return sessionID
}

async function insertSessionRow(sessionID: SessionID, persistMode: "pvc" | "snapshot") {
  await db.insert(SessionTable).values({
    id: sessionID,
    project_id: PROJ_ID,
    slug: sessionID,
    directory: "/tmp/dbid",
    title: "dbid",
    version: "local",
    sandbox: { cpu: "1", memory: "1Gi", persistMode },
  }).onConflictDoNothing().run()
}

async function getSandboxState(sessionID: SessionID) {
  const rows = await db.select({ id: SandboxTable.id, state: SandboxTable.state })
    .from(SandboxTable).where(eq(SandboxTable.session_id, sessionID)).limit(1)
  return rows[0] ?? null
}

async function cleanup(prefix: string) {
  await db.delete(SandboxTable).where(like(SandboxTable.session_id, `${prefix}%`)).run()
  await db.delete(SessionSnapshotTable).where(like(SessionSnapshotTable.session_id, `${prefix}%`)).run()
  await db.delete(SessionTable).where(like(SessionTable.id, `${prefix}%`)).run()
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 15_000) {
  for (let i = 0; i < timeoutMs / 200; i++) {
    if (await predicate()) return true
    await Bun.sleep(200)
  }
  return false
}

const indexOfRequest = (method: string, needle: string) =>
  requests.findIndex((r) => r.method === method && r.path.includes(needle))

describe.skipIf(!enabled)("pgLayer - destroyById", () => {
  beforeAll(async () => {
    db = Database.Client()
    await Database.initialize()
    await db.insert(ProjectTable).values({
      id: PROJ_ID,
      worktree: "/tmp/dbid",
      sandboxes: [],
    }).onConflictDoNothing().run()
    await Effect.runPromise(Effect.gen(function* () {
      scope = yield* Scope.make()
      context = yield* Layer.buildWithScope(SandboxProvider.pgLayer.pipe(Layer.provide(configLayer)), scope)
    }))
  }, 30_000)

  afterAll(async () => {
    context = undefined
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void).pipe(Effect.catchCause(() => Effect.void)))
    }
    await cleanup(SID_PREFIX)
    lifecycle.stop(true)
  })

  test("pvc 会话 + running 沙箱（host 不可达）：返回 sessionID，行转 destroyed，killByID 发出 DELETE", async () => {
    const name = "pvc_unreachable"
    const sessionID = await insertFixtures(name, { persistMode: "pvc", host: "http://127.0.0.1:1" })
    await insertSessionRow(sessionID, "pvc")
    requests.length = 0

    const result = await Effect.runPromise(svc().destroyById(`sb_${name}`))
    expect(result).toBe(sessionID)

    const deleted = await waitFor(() => Promise.resolve(indexOfRequest("DELETE", `sb_${name}`) >= 0))
    expect(deleted).toBe(true)
    const ok = await waitFor(async () => (await getSandboxState(sessionID))?.state === "destroyed")
    expect(ok).toBe(true)
  })

  test("snapshot 会话 + running 沙箱：先快照（POST snapshots）后销毁（DELETE sandboxes）", async () => {
    const name = "snap_ok"
    const sessionID = await insertFixtures(name, { persistMode: "snapshot", host: lifecycle.url.host })
    await insertSessionRow(sessionID, "snapshot")
    requests.length = 0

    const result = await Effect.runPromise(svc().destroyById(`sb_${name}`))
    expect(result).toBe(sessionID)

    const deleted = await waitFor(() => Promise.resolve(indexOfRequest("DELETE", `/v1/sandboxes/sb_${name}`) >= 0))
    expect(deleted).toBe(true)

    const snapIdx = indexOfRequest("POST", `/v1/sandboxes/sb_${name}/snapshots`)
    expect(snapIdx).toBeGreaterThanOrEqual(0)
    const deleteIdx = indexOfRequest("DELETE", `/v1/sandboxes/sb_${name}`)
    expect(snapIdx).toBeLessThan(deleteIdx)
  })

  test("snapshot 会话 + 快照失败（轮询到 Failed）：沙箱保留（无 DELETE），行保持 killed", async () => {
    const name = "snap_fail"
    const sessionID = await insertFixtures(name, { persistMode: "snapshot", host: lifecycle.url.host })
    await insertSessionRow(sessionID, "snapshot")
    snapshotPollState.set(`snap_sb_${name}`, "Failed")
    requests.length = 0

    const result = await Effect.runPromise(svc().destroyById(`sb_${name}`))
    expect(result).toBe(sessionID)

    const failed = await waitFor(async () =>
      (await db.select().from(SessionSnapshotTable).where(eq(SessionSnapshotTable.id, `snap_sb_${name}`)).limit(1))[0]?.state === "failed")
    expect(failed).toBe(true)
    expect(indexOfRequest("DELETE", `/v1/sandboxes/sb_${name}`)).toBe(-1)
    expect((await getSandboxState(sessionID))?.state).toBe("killed")
    snapshotPollState.delete(`snap_sb_${name}`)
  }, 40_000)

  test("killed 行：返回 null 且不产生销毁请求", async () => {
    const name = "killed_row"
    const sessionID = await insertFixtures(name, { persistMode: "pvc", host: lifecycle.url.host, state: "killed" })
    await insertSessionRow(sessionID, "pvc")
    requests.length = 0

    const result = await Effect.runPromise(svc().destroyById(`sb_${name}`))
    expect(result).toBeNull()
    expect(indexOfRequest("DELETE", `sb_${name}`)).toBe(-1)
  })

  test("destroyed 行与不存在的 ID：返回 null", async () => {
    const name = "destroyed_row"
    const sessionID = await insertFixtures(name, { persistMode: "pvc", host: lifecycle.url.host, state: "destroyed" })
    await insertSessionRow(sessionID, "pvc")

    const gone = await Effect.runPromise(svc().destroyById(`sb_${name}`))
    expect(gone).toBeNull()

    const missing = await Effect.runPromise(svc().destroyById("sb_never_existed"))
    expect(missing).toBeNull()
  })

  test("destroy(pvc 会话)：沙箱被销毁，行转 destroyed", async () => {
    const name = "destroy_pvc"
    const sessionID = await insertFixtures(name, { persistMode: "pvc", host: "http://127.0.0.1:1" })
    await insertSessionRow(sessionID, "pvc")
    requests.length = 0

    await Effect.runPromise(svc().destroy(sessionID))

    const deleted = await waitFor(() => Promise.resolve(indexOfRequest("DELETE", `sb_${name}`) >= 0))
    expect(deleted).toBe(true)
    const ok = await waitFor(async () => (await getSandboxState(sessionID))?.state === "destroyed")
    expect(ok).toBe(true)
  })

  test("destroy(snapshot 会话)：先快照（POST snapshots）后销毁（DELETE sandboxes）", async () => {
    const name = "destroy_snap"
    const sessionID = await insertFixtures(name, { persistMode: "snapshot", host: lifecycle.url.host })
    await insertSessionRow(sessionID, "snapshot")
    requests.length = 0

    await Effect.runPromise(svc().destroy(sessionID))

    const deleted = await waitFor(() => Promise.resolve(indexOfRequest("DELETE", `/v1/sandboxes/sb_${name}`) >= 0))
    expect(deleted).toBe(true)
    const snapIdx = indexOfRequest("POST", `/v1/sandboxes/sb_${name}/snapshots`)
    expect(snapIdx).toBeGreaterThanOrEqual(0)
    expect(snapIdx).toBeLessThan(indexOfRequest("DELETE", `/v1/sandboxes/sb_${name}`))
  })

  test("destroy(snapshot 会话) 快照失败：无 DELETE，行保持 killed", async () => {
    const name = "destroy_snap_fail"
    const sessionID = await insertFixtures(name, { persistMode: "snapshot", host: lifecycle.url.host })
    await insertSessionRow(sessionID, "snapshot")
    snapshotPollState.set(`snap_sb_${name}`, "Failed")
    requests.length = 0

    await Effect.runPromise(svc().destroy(sessionID))

    const failed = await waitFor(async () =>
      (await db.select().from(SessionSnapshotTable).where(eq(SessionSnapshotTable.id, `snap_sb_${name}`)).limit(1))[0]?.state === "failed")
    expect(failed).toBe(true)
    expect(indexOfRequest("DELETE", `/v1/sandboxes/sb_${name}`)).toBe(-1)
    expect((await getSandboxState(sessionID))?.state).toBe("killed")
    snapshotPollState.delete(`snap_sb_${name}`)
  }, 40_000)

  test("destroy(无沙箱行)：无副作用", async () => {
    const sessionID = sid(`${SID_PREFIX}destroy_norow`)
    requests.length = 0

    await Effect.runPromise(svc().destroy(sessionID))

    expect(requests.filter((r) => r.method === "DELETE")).toEqual([])
  })
})
