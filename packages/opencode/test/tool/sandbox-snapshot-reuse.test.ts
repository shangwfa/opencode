/**
 * 快照无变更复用（T25.24）单元测试
 *
 * 覆盖：
 * - snapshotDirtyCheckCommand 判定脚本：marker 缺失=dirty、无新写入=clean、新写入=dirty（本地真实执行）
 * - workspaceUnchangedSinceSnapshot：exitCode 映射（0=clean）与异常回退（reject/非零=dirty）
 * - findRestorable：仅 ready/stale 参与、返回最新一条
 * - 回退安全：execd 通道不可用时 destroy 仍走「先快照后销毁」原路径（无变更判定失败不得破坏既有语义）
 *
 * 运行方式：
 *   OPENCODE_DATABASE_URL=postgresql://local@127.0.0.1:5432/opencode_test \
 *   bun test test/tool/sandbox-snapshot-reuse.test.ts
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import fs from "node:fs/promises"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import { eq, like } from "drizzle-orm"
import { Database } from "../../src/storage/db"
import { SandboxTable } from "../../src/tool/sandbox.pg"
import { SessionTable } from "../../src/session/session.pg"
import { SessionSnapshotTable } from "../../src/tool/session-snapshot.pg"
import { SessionSnapshot } from "../../src/tool/session-snapshot"
import { ProjectTable } from "../../src/project/project.pg"
import {
  SandboxProvider,
  SandboxConfig,
  SNAPSHOT_MARKER_PATH,
  snapshotDirtyCheckCommand,
  snapshotManifestCommand,
  workspaceUnchangedSinceSnapshot,
} from "../../src/tool/sandbox-provider"
import type { SessionID } from "../../src/session/schema"
import type { ProjectV2 } from "@opencode-ai/core/project"
import type { Sandbox } from "@alibaba-group/opensandbox"

const DB_URL = process.env.OPENCODE_DATABASE_URL
const enabled = (() => {
  if (!DB_URL) return false
  const url = new URL(DB_URL)
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/opencode_test"
})()

let db: ReturnType<typeof Database.Client>

// ── 判定脚本（真实执行，不 mock）─────────────────────────────────────

async function runScript(cmd: string) {
  const proc = Bun.spawn(["bash", "-c", cmd], { stdout: "pipe", stderr: "ignore" })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return out
}

describe("snapshotDirtyCheckCommand", () => {
  // 模拟 touchSnapshotMarker 效果：写 marker + 生成 size 清单
  const touchMarkerWithManifest = async (marker: string, manifest: string, ws: string) => {
    await fs.writeFile(marker, "")
    await runScript(snapshotManifestCommand(ws, manifest))
  }

  test("marker 缺失 → DIRTY（保守）", async () => {
    const dir = await mkdtemp()
    const marker = `${dir}/.nonexistent-marker`
    const manifest = `${dir}/.nonexistent-manifest`
    const out = await runScript(snapshotDirtyCheckCommand(marker, manifest, `${dir}/workspace`, 0))
    expect(out).toContain("DIRTY")
    await rmrf(dir)
  })

  test("marker + manifest 存在且 workspace 无新写入 → CLEAN", async () => {
    const dir = await mkdtemp()
    const marker = `${dir}/.marker`
    const manifest = `${dir}/.manifest`
    const ws = `${dir}/workspace`
    await fs.mkdir(ws, { recursive: true })
    await fs.writeFile(`${ws}/a.txt`, "hello")
    await new Promise((r) => setTimeout(r, 60))
    await touchMarkerWithManifest(marker, manifest, ws)
    const out = await runScript(snapshotDirtyCheckCommand(marker, manifest, ws, 0))
    expect(out).toContain("CLEAN")
    await rmrf(dir)
  })

  test("marker 之后有新写入 → DIRTY", async () => {
    const dir = await mkdtemp()
    const marker = `${dir}/.marker`
    const manifest = `${dir}/.manifest`
    const ws = `${dir}/workspace`
    await fs.mkdir(ws, { recursive: true })
    await fs.writeFile(`${ws}/a.txt`, "hello")
    await touchMarkerWithManifest(marker, manifest, ws)
    await new Promise((r) => setTimeout(r, 60))
    await fs.writeFile(`${ws}/b.txt`, "changed")
    const out = await runScript(snapshotDirtyCheckCommand(marker, manifest, ws, 0))
    expect(out).toContain("DIRTY")
    await rmrf(dir)
  })

  test("同尺寸覆盖写且 mtime 被回填为旧时间（tar/cp -p 语义）→ DIRTY（SHA-256 兜底）", async () => {
    const dir = await mkdtemp()
    const marker = `${dir}/.marker`
    const manifest = `${dir}/.manifest`
    const ws = `${dir}/workspace`
    await fs.mkdir(ws, { recursive: true })
    await fs.writeFile(`${ws}/a.txt`, "old")
    await touchMarkerWithManifest(marker, manifest, ws)
    await new Promise((r) => setTimeout(r, 60))
    await fs.writeFile(`${ws}/a.txt`, "new")
    // 回填旧 mtime（模拟 tar -x / cp -p / rsync -a）
    await fs.utimes(`${ws}/a.txt`, new Date("2020-01-01"), new Date("2020-01-01"))
    const out = await runScript(snapshotDirtyCheckCommand(marker, manifest, ws, 0))
    expect(out).toContain("DIRTY")
    await rmrf(dir)
  })

  test("manifest 缺失但 mtime 无变更 → DIRTY（内容清单兜底保守分支）", async () => {
    const dir = await mkdtemp()
    const marker = `${dir}/.marker`
    const manifest = `${dir}/.manifest`
    const ws = `${dir}/workspace`
    await fs.mkdir(ws, { recursive: true })
    await fs.writeFile(`${ws}/a.txt`, "hello")
    await new Promise((r) => setTimeout(r, 60))
    await fs.writeFile(marker, "")
    // 不生成 manifest
    const out = await runScript(snapshotDirtyCheckCommand(marker, manifest, ws, 0))
    expect(out).toContain("DIRTY")
    await rmrf(dir)
  })

  test("内容清单与现状不符 → DIRTY（清单比对分支生效）", async () => {
    const dir = await mkdtemp()
    const marker = `${dir}/.marker`
    const manifest = `${dir}/.manifest`
    const ws = `${dir}/workspace`
    await fs.mkdir(ws, { recursive: true })
    await fs.writeFile(`${ws}/a.txt`, "hello")
    await touchMarkerWithManifest(marker, manifest, ws)
    // 篡改清单（模拟 mtime 分辨率无法捕获、但内容已变的极端场景）
    await fs.appendFile(manifest, "ghost.txt sha256\n")
    const out = await runScript(snapshotDirtyCheckCommand(marker, manifest, ws, 0))
    expect(out).toContain("DIRTY")
    await rmrf(dir)
  })
})

async function mkdtemp() {
  return fs.mkdtemp("/tmp/opencode-snapreuse-")
}

async function rmrf(dir: string) {
  await fs.rm(dir, { recursive: true, force: true })
}

// ── Effect 判定映射（stub Sandbox，仅命令通道）──────────────────────

const stubSandbox = (behavior: { stdout?: string; reject?: Error }) =>
  ({
    commands: {
      createSession: async () => {
        if (behavior.reject) throw behavior.reject
        return "snapshot-check"
      },
      runInSession: async () => {
        if (behavior.reject) throw behavior.reject
        return { logs: { stdout: [{ text: behavior.stdout ?? "CLEAN\n", timestamp: 0 }], stderr: [] }, result: [] }
      },
      deleteSession: async () => undefined,
    },
  }) as unknown as Sandbox

describe("workspaceUnchangedSinceSnapshot", () => {
  test("stdout 含 CLEAN → true", async () => {
    expect(await Effect.runPromise(workspaceUnchangedSinceSnapshot(stubSandbox({ stdout: "CLEAN\n" })))).toBe(true)
  })

  test("stdout 为 DIRTY → false", async () => {
    expect(await Effect.runPromise(workspaceUnchangedSinceSnapshot(stubSandbox({ stdout: "DIRTY\n" })))).toBe(false)
  })

  test("stdout 为空 → false（保守 dirty）", async () => {
    expect(await Effect.runPromise(workspaceUnchangedSinceSnapshot(stubSandbox({ stdout: "" })))).toBe(false)
  })

  test("命令通道异常 → false（保守 dirty）", async () => {
    expect(await Effect.runPromise(workspaceUnchangedSinceSnapshot(stubSandbox({ reject: new Error("execd down") })))).toBe(false)
  })
})

// ── findRestorable 状态机（PG）───────────────────────────────────────

describe.skipIf(!enabled)("findRestorable", () => {
  const SID = "ses_snapreuse_restorable"

  beforeAll(async () => {
    db = Database.Client()
    await Database.initialize()
    await db.delete(SessionSnapshotTable).where(like(SessionSnapshotTable.session_id, SID)).run()
  })

  afterAll(async () => {
    await db.delete(SessionSnapshotTable).where(like(SessionSnapshotTable.session_id, SID)).run()
  })

  test("仅 ready/stale 参与，返回最新一条", async () => {
    const now = Date.now()
    await db.insert(SessionSnapshotTable).values([
      { id: "snap_reuse_stale_old", session_id: SID, scope: "session", state: "stale", time_created: now - 3000, time_updated: now - 3000 },
      { id: "snap_reuse_ready_new", session_id: SID, scope: "session", state: "ready", time_created: now - 2000, time_updated: now - 2000 },
      { id: "snap_reuse_failed_newest", session_id: SID, scope: "session", state: "failed", time_created: now - 1000, time_updated: now - 1000 },
    ]).run()

    const snapshots = SessionSnapshot.create({
      pgDb: db,
      connectionConfig: fakeConnectionConfig(),
      ttlMs: 86_400_000,
      waitMs: 10_000,
    })
    const row = await snapshots.findRestorable(SID)
    expect(row?.id).toBe("snap_reuse_ready_new")
    expect(await snapshots.resolveForCreate(SID)).toBe("snap_reuse_ready_new")
  })

  test("无可恢复快照 → null", async () => {
    await db.delete(SessionSnapshotTable).where(like(SessionSnapshotTable.session_id, SID)).run()
    const snapshots = SessionSnapshot.create({
      pgDb: db,
      connectionConfig: fakeConnectionConfig(),
      ttlMs: 86_400_000,
      waitMs: 10_000,
    })
    expect(await snapshots.findRestorable(SID)).toBeNull()
  })

  test("仅 stale（已恢复）快照也可复用", async () => {
    await db.delete(SessionSnapshotTable).where(like(SessionSnapshotTable.session_id, SID)).run()
    await db.insert(SessionSnapshotTable).values({
      id: "snap_reuse_stale_only",
      session_id: SID,
      scope: "session",
      state: "stale",
      time_created: Date.now(),
      time_updated: Date.now(),
    }).run()
    const snapshots = SessionSnapshot.create({
      pgDb: db,
      connectionConfig: fakeConnectionConfig(),
      ttlMs: 86_400_000,
      waitMs: 10_000,
    })
    expect((await snapshots.findRestorable(SID))?.id).toBe("snap_reuse_stale_only")  })
})

import { ConnectionConfig } from "@alibaba-group/opensandbox"
const fakeConnectionConfig = () => new ConnectionConfig({ domain: "127.0.0.1:1", protocol: "http" })

// ── 快照复用（destroy 路径，PG + mock server）────────────────────────

// true 时临时 command session 输出 CLEAN；false 时 session 创建失败（回退）
let commandClean = false

const lifecycle = Bun.serve({
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname
    requests.push({ method: request.method, path })
    if (request.method === "GET" && path === "/ping") return new Response("ok")
    if (request.method === "POST" && path === "/session") {
      if (commandClean) return Response.json({ session_id: "snapshot-check" })
      return Response.json({ code: "NOT_FOUND", message: "not found" }, { status: 404 })
    }
    if (request.method === "POST" && path === "/session/snapshot-check/run") {
      if (commandClean) {
        return new Response('{"type":"stdout","text":"CLEAN\\n"}\n{"type":"execution_complete"}\n', { headers: { "content-type": "text/event-stream" } })
      }
      return Response.json({ code: "NOT_FOUND", message: "not found" }, { status: 404 })
    }
    if (request.method === "DELETE" && path === "/session/snapshot-check") return new Response(null, { status: 200 })
    if (request.method === "POST" && /^\/v1\/sandboxes\/[^/]+\/snapshots$/.test(path)) {
      const sandboxId = path.split("/")[3]
      return Response.json({ id: `snap_${sandboxId}`, createdAt: new Date().toISOString(), status: { state: "Creating" } })
    }
    if (request.method === "GET" && /^\/v1\/snapshots\/[^/]+$/.test(path)) {
      const snapshotId = path.split("/")[3]
      return Response.json({ id: snapshotId, createdAt: new Date().toISOString(), status: { state: "Ready" } })
    }
    if (request.method === "DELETE" && /^\/v1\/snapshots\/[^/]+$/.test(path)) return new Response(null, { status: 200 })
    if (request.method === "GET" && path === "/v1/snapshots") return Response.json({ items: [] })
    if (request.method === "GET" && path.includes("/endpoints/")) {
      return Response.json({ endpoint: new URL(request.url).host, headers: {} })
    }
    if (request.method === "DELETE" && path.startsWith("/v1/sandboxes/")) return new Response(null, { status: 200 })
    // commands/proxy 其余路径一律 404
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

const PROJ_ID = "proj_snapreuse_test" as ProjectV2.ID
const SID_PREFIX = "ses_snapreuse_"
const sid = (s: string) => s as SessionID

let scope: Scope.Scope | undefined
let context: Context.Context<SandboxProvider.Service> | undefined
const svc = () => Context.get(context!, SandboxProvider.Service)

const requests: Array<{ method: string; path: string }> = []
const indexOfRequest = (method: string, needle: string) =>
  requests.findIndex((r) => r.method === method && r.path.includes(needle))

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 20_000) {
  for (let i = 0; i < timeoutMs / 200; i++) {
    if (await predicate()) return true
    await Bun.sleep(200)
  }
  return false
}

async function getSandboxState(sessionID: SessionID) {
  const rows = await db.select({ id: SandboxTable.id, state: SandboxTable.state })
    .from(SandboxTable).where(eq(SandboxTable.session_id, sessionID)).limit(1)
  return rows[0] ?? null
}

async function insertSnapshotSession(name: string, opts: { readySnapshot?: boolean } = {}) {
  const sessionID = sid(`${SID_PREFIX}${name}`)
  await db.insert(SessionTable).values({
    id: sessionID,
    project_id: PROJ_ID,
    slug: sessionID,
    directory: "/tmp/snapreuse",
    title: "snapreuse",
    version: "local",
    sandbox: { cpu: "1", memory: "1Gi", persistMode: "snapshot" },
  }).onConflictDoNothing().run()
  await db.insert(SandboxTable).values({
    id: `sb_${name}`,
    session_id: sessionID,
    host: lifecycle.url.host,
    state: "running",
    keep_alive: false,
    command_session_id: null,
    time_created: Date.now(),
    time_updated: Date.now(),
  }).onConflictDoNothing().run()
  if (opts.readySnapshot) {
    await db.insert(SessionSnapshotTable).values({
      id: `snap_${name}_ready`,
      session_id: sessionID,
      scope: "session",
      state: "ready",
      time_created: Date.now(),
      time_updated: Date.now(),
    }).run()
  }
  return sessionID
}

describe.skipIf(!enabled)("快照复用（destroy 路径）", () => {
  beforeAll(async () => {
    db = Database.Client()
    await Database.initialize()
    await db.insert(ProjectTable).values({ id: PROJ_ID, worktree: "/tmp/snapreuse", sandboxes: [] }).onConflictDoNothing().run()
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
    await db.delete(SandboxTable).where(like(SandboxTable.session_id, `${SID_PREFIX}%`)).run()
    await db.delete(SessionSnapshotTable).where(like(SessionSnapshotTable.session_id, `${SID_PREFIX}%`)).run()
    await db.delete(SessionTable).where(like(SessionTable.id, `${SID_PREFIX}%`)).run()
    lifecycle.stop(true)
  })

  test("复用主路径：workspace 无变更且有 ready 快照 → 跳过 startSnapshot 直接销毁，快照表无新记录", async () => {
    const name = "reuse"
    const sessionID = await insertSnapshotSession(name, { readySnapshot: true })
    commandClean = true
    requests.length = 0

    await Effect.runPromise(svc().destroy(sessionID))

    const deleted = await waitFor(async () => (await getSandboxState(sessionID))?.state === "destroyed")
    expect(deleted).toBe(true)
    // 复用路径：不发 POST /v1/sandboxes/<id>/snapshots
    expect(indexOfRequest("POST", `/v1/sandboxes/sb_${name}/snapshots`)).toBe(-1)
    expect(indexOfRequest("DELETE", `/v1/sandboxes/sb_${name}`)).toBeGreaterThanOrEqual(0)
    // 快照表仍只有原 ready 记录，无新增 creating/ready
    const snaps = await db.select().from(SessionSnapshotTable).where(eq(SessionSnapshotTable.session_id, sessionID)).all()
    expect(snaps.length).toBe(1)
    expect(snaps[0]?.id).toBe(`snap_${name}_ready`)
    expect(snaps[0]?.state).toBe("ready")
    commandClean = false
  }, 40_000)

  test("workspace 无变更但无可复用快照 → 回退走完整快照路径", async () => {
    const name = "reuse_nosnap"
    const sessionID = await insertSnapshotSession(name)
    commandClean = true
    requests.length = 0

    await Effect.runPromise(svc().destroy(sessionID))

    // 快照在后台 fiber 异步进行，先等终态再断言
    const deleted = await waitFor(async () => (await getSandboxState(sessionID))?.state === "destroyed")
    expect(deleted).toBe(true)
    const snapIdx = indexOfRequest("POST", `/v1/sandboxes/sb_${name}/snapshots`)
    expect(snapIdx).toBeGreaterThanOrEqual(0)
    expect(snapIdx).toBeLessThan(indexOfRequest("DELETE", `/v1/sandboxes/sb_${name}`))
    commandClean = false
  }, 40_000)

  test("回退安全：脏检查通道不可用（/command 404）时仍先快照后销毁，语义不回归", async () => {
    const name = "fallback"
    const sessionID = await insertSnapshotSession(name)
    commandClean = false
    requests.length = 0

    await Effect.runPromise(svc().destroy(sessionID))

    const deleted = await waitFor(async () => (await getSandboxState(sessionID))?.state === "destroyed")
    expect(deleted).toBe(true)
    const snapIdx = indexOfRequest("POST", `/v1/sandboxes/sb_${name}/snapshots`)
    expect(snapIdx).toBeGreaterThanOrEqual(0)
    expect(snapIdx).toBeLessThan(indexOfRequest("DELETE", `/v1/sandboxes/sb_${name}`))
  }, 40_000)
})
