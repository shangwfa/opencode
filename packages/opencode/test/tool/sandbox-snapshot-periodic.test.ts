/**
 * 周期性快照保鲜（T25.33~T25.36）单元测试
 *
 * 覆盖：
 * - flag 默认值与开关
 * - 保鲜扫描轮：空闲超间隔的快照会话入队 snapshot_refresh；非快照会话/快照已覆盖/未超间隔不入队
 * - runSnapshotRefresh：快照 Ready 后保留源沙箱（不发 DELETE）；不信任未确认 marker
 * - 沙箱已死分支：对账收敛（行 destroyed）+ 快照落后时 snapshot-lag-warning 告警 / 快照够新不告警
 * - runSnapshotDestroy 死亡分支同样接告警（cause=sandbox gone before snapshot）
 * - drain 按 kind 分派：refresh 不销毁、destroy 照旧销毁
 *
 * 运行方式：
 *   OPENCODE_DATABASE_URL=postgresql://local@127.0.0.1:5432/opencode_test \
 *   bun test test/tool/sandbox-snapshot-periodic.test.ts
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import { and, eq, like } from "drizzle-orm"
import { Database } from "../../src/storage/db"
import { SandboxTable } from "../../src/tool/sandbox.pg"
import { SessionTable } from "../../src/session/session.pg"
import { SessionSnapshotTable, SnapshotOperationTable, SnapshotRefreshOperationTable } from "../../src/tool/session-snapshot.pg"
import { ExecLogTable, type ExecLogSource } from "../../src/session/exec-log.pg"
import { ProjectTable } from "../../src/project/project.pg"
import { SandboxProvider, SandboxConfig } from "../../src/tool/sandbox-provider"
import { Flag } from "../../src/flag/flag"
import type { SessionID } from "../../src/session/schema"
import type { ProjectV2 } from "@opencode-ai/core/project"

const DB_URL = process.env.OPENCODE_DATABASE_URL
const enabled = (() => {
  if (!DB_URL) return false
  const url = new URL(DB_URL)
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/opencode_test"
})()

let db: ReturnType<typeof Database.Client>

// ── flag 默认值（无 DB 依赖）─────────────────────────────────────────

describe("snapshot periodic flags", () => {
  test("默认开启，间隔 1800s", () => {
    expect(Flag.OPENCODE_SANDBOX_SNAPSHOT_PERIODIC_ENABLED).toBe(true)
    expect(Flag.OPENCODE_SANDBOX_SNAPSHOT_INTERVAL_SEC).toBe(1800)
  })
})

// ── mock OpenSandbox lifecycle server ────────────────────────────────

// 只有加入 aliveSandboxes 的沙箱 connect（GET endpoints）才 200；其余 404 = 平台侧已消失
const aliveSandboxes = new Set<string>()
// true 时临时 command session 输出 CLEAN（无变更复用路径）；false 时 404（保守 dirty 走快照）
let commandClean = false
// true 时 POST snapshots 返回 500（startSnapshot 失败 → 操作退避重试路径）
let snapshotCreateFails = false
// true 时远端快照一直停在 Creating（refresh 短超时释放 fence 路径）
let snapshotsStuckCreating = false

const requests: Array<{ method: string; path: string }> = []
const indexOfRequest = (method: string, needle: string) =>
  requests.findIndex((r) => r.method === method && r.path.includes(needle))
const countRequests = (method: string, needle: string) =>
  requests.filter((r) => r.method === method && r.path.includes(needle)).length
// 真实远端每次 createSnapshot 生成全新 ID；同沙箱多次快照必须不同 ID（否则 insert 主键冲突）
let snapshotSeq = 0

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
    if (request.method === "GET" && path.includes("/endpoints/")) {
      const sandboxId = path.split("/")[3]
      if (!aliveSandboxes.has(sandboxId)) return Response.json({ code: "NOT_FOUND", message: "sandbox gone" }, { status: 404 })
      return Response.json({ endpoint: new URL(request.url).host, headers: {} })
    }
    if (request.method === "POST" && /^\/v1\/sandboxes\/[^/]+\/snapshots$/.test(path)) {
      if (snapshotCreateFails) return Response.json({ code: "INTERNAL", message: "simulated create failure" }, { status: 500 })
      const sandboxId = path.split("/")[3]
      snapshotSeq += 1
      return Response.json({ id: `snap_${sandboxId}_${snapshotSeq}`, createdAt: new Date().toISOString(), status: { state: "Creating" } })
    }
    if (request.method === "GET" && /^\/v1\/snapshots\/[^/]+$/.test(path)) {
      const snapshotId = path.split("/")[3]
      const state = snapshotsStuckCreating ? "Creating" : "Ready"
      return Response.json({ id: snapshotId, createdAt: new Date().toISOString(), status: { state } })
    }
    if (request.method === "DELETE" && /^\/v1\/snapshots\/[^/]+$/.test(path)) return new Response(null, { status: 200 })
    if (request.method === "GET" && path === "/v1/snapshots") return Response.json({ items: [] })
    if (request.method === "DELETE" && path.startsWith("/v1/sandboxes/")) return new Response(null, { status: 200 })
    return Response.json({ code: "NOT_FOUND", message: "not found" }, { status: 404 })
  },
})

// 保鲜间隔 2s + 扫描 400ms；idleReapMs=1h（禁用销毁轮，让 refresh 轮独立受测）
const config = SandboxConfig.Service.of({
  domain: lifecycle.url.host,
  protocol: "http",
  apiKey: "",
  useServerProxy: false,
  image: "fake",
  snapshotImage: "fake-snap",
  timeoutSeconds: 300,
  resourceLimits: { cpu: "1", memory: "2Gi" },
  volumeType: "none" as const,
  pvcClaimName: "",
  snapshotTtlMs: 7 * 86400_000,
  snapshotWaitMs: 3_000,
  idleKillMs: 3_600_000,
  idleReapMs: 3_600_000,
  idleReapIntervalMs: 400,
  snapshotIntervalMs: 2_000,
  maxTtlSeconds: 3600,
  packageCacheMount: "/cache",
  snapshotPrune: false,
  cleanupOnScopeExit: false,
})
const configLayer = Layer.succeed(SandboxConfig.Service, config)

const PROJ_ID = "proj_snapperiodic_test" as ProjectV2.ID
const SID_PREFIX = "ses_snapper_"
const sid = (s: string) => s as SessionID

let scope: Scope.Scope | undefined
let context: Context.Context<SandboxProvider.Service> | undefined
const svc = () => Context.get(context!, SandboxProvider.Service)

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 20_000) {
  for (let i = 0; i < timeoutMs / 200; i++) {
    if (await predicate()) return true
    await Bun.sleep(200)
  }
  return false
}

async function getSandboxRow(sessionID: SessionID) {
  const rows = await db.select().from(SandboxTable).where(eq(SandboxTable.session_id, sessionID)).limit(1)
  return rows[0] ?? null
}

async function getLatestSnapshot(sessionID: SessionID) {
  const rows = await db
    .select()
    .from(SessionSnapshotTable)
    .where(eq(SessionSnapshotTable.session_id, sessionID))
    .orderBy(SessionSnapshotTable.time_created)
    .all()
  return rows[rows.length - 1] ?? null
}

async function refreshOps(sessionID: SessionID) {
  return db
    .select()
    .from(SnapshotRefreshOperationTable)
    .where(and(eq(SnapshotRefreshOperationTable.session_id, sessionID), eq(SnapshotRefreshOperationTable.kind, "snapshot_refresh")))
    .all() as Promise<Array<{ state: string; attempts: number }>>
}

async function execLogSources(sessionID: SessionID, source: ExecLogSource) {
  return db.select().from(ExecLogTable).where(and(eq(ExecLogTable.session_id, sessionID), eq(ExecLogTable.source, source))).all()
}

/** 插入快照会话 + running 沙箱行 + 可选既有快照（ageMs 控制落后程度）。 */
async function insertSession(
  name: string,
  opts: {
    persistMode?: "snapshot" | "pvc"
    sandboxAgeMs?: number
    snapshotAgeMs?: number
    alive?: boolean
  } = {},
) {
  const sessionID = sid(`${SID_PREFIX}${name}`)
  const sandboxID = `sb_${name}`
  await db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: PROJ_ID,
      slug: sessionID,
      directory: "/tmp/snapperiodic",
      title: "snapperiodic",
      version: "local",
      sandbox: { cpu: "1", memory: "1Gi", persistMode: opts.persistMode ?? "snapshot" },
    })
    .onConflictDoNothing()
    .run()
  const now = Date.now()
  await db
    .insert(SandboxTable)
    .values({
      id: sandboxID,
      session_id: sessionID,
      host: lifecycle.url.host,
      state: "running",
      keep_alive: true,
      command_session_id: null,
      time_created: now - (opts.sandboxAgeMs ?? 0),
      time_updated: now - (opts.sandboxAgeMs ?? 0),
    })
    .onConflictDoNothing()
    .run()
  if (opts.snapshotAgeMs !== undefined) {
    const ts = now - opts.snapshotAgeMs
    await db
      .insert(SessionSnapshotTable)
      .values({
        id: `snap_${name}_seed`,
        session_id: sessionID,
        scope: "session",
        state: "ready",
        time_created: ts,
        time_updated: ts,
      })
      .run()
  }
  if (opts.alive !== false) aliveSandboxes.add(sandboxID)
  return sessionID
}

describe.skipIf(!enabled)("周期性快照保鲜", () => {
  beforeAll(async () => {
    db = Database.Client()
    await Database.initialize()
    await db.insert(ProjectTable).values({ id: PROJ_ID, worktree: "/tmp/snapperiodic", sandboxes: [] }).onConflictDoNothing().run()
    await Effect.runPromise(
      Effect.gen(function* () {
        scope = yield* Scope.make()
        context = yield* Layer.buildWithScope(SandboxProvider.pgLayer.pipe(Layer.provide(configLayer)), scope)
      }),
    )
  }, 30_000)

  afterAll(async () => {
    context = undefined
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void).pipe(Effect.catchCause(() => Effect.void)))
    }
    await db.delete(SandboxTable).where(like(SandboxTable.session_id, `${SID_PREFIX}%`)).run()
    await db.delete(SessionSnapshotTable).where(like(SessionSnapshotTable.session_id, `${SID_PREFIX}%`)).run()
    await db.delete(SnapshotOperationTable).where(like(SnapshotOperationTable.session_id, `${SID_PREFIX}%`)).run()
    await db.delete(SnapshotRefreshOperationTable).where(like(SnapshotRefreshOperationTable.session_id, `${SID_PREFIX}%`)).run()
    await db.delete(ExecLogTable).where(like(ExecLogTable.session_id, `${SID_PREFIX}%`)).run()
    await db.delete(SessionTable).where(like(SessionTable.id, `${SID_PREFIX}%`)).run()
    lifecycle.stop(true)
  })

  test("空闲超间隔 → 入队 refresh、快照 Ready、源沙箱保留", async () => {
    const sessionID = await insertSession("main", { sandboxAgeMs: 3_000 })
    requests.length = 0
    commandClean = false

    const ready = await waitFor(async () => (await getLatestSnapshot(sessionID))?.state === "ready")
    expect(ready).toBe(true)
    // 快照来自远端 createSnapshot（seed 无 → 新建）
    expect(countRequests("POST", `/v1/sandboxes/sb_main/snapshots`)).toBeGreaterThanOrEqual(1)
    // 保鲜不销毁：沙箱行仍 running 且未发 DELETE /v1/sandboxes/sb_main
    expect((await getSandboxRow(sessionID))?.state).toBe("running")
    expect(countRequests("DELETE", "/v1/sandboxes/sb_main")).toBe(0)
    // 审计落库：snapshot-refresh exec_log
    const audits = await execLogSources(sessionID, "snapshot-refresh")
    expect(audits.length).toBeGreaterThanOrEqual(1)
    const detail = JSON.parse(audits[0]!.command)
    expect(detail.sandboxID).toBe("sb_main")
    expect(detail.snapshotId).toBeTruthy()
    // 操作行终态 done（7 天保留期内可查）
    const done = await waitFor(async () => (await refreshOps(sessionID)).some((op) => op.state === "done"))
    expect(done).toBe(true)
    const legacyOps = await db
      .select()
      .from(SnapshotOperationTable)
      .where(and(eq(SnapshotOperationTable.session_id, sessionID), eq(SnapshotOperationTable.kind, "snapshot_refresh")))
      .all()
    expect(legacyOps).toEqual([])
    // 覆盖判定：新快照晚于最后活动 → 不再重复入队
    const snap = await getLatestSnapshot(sessionID)
    expect(snap!.time_created).toBeGreaterThanOrEqual((await getSandboxRow(sessionID))!.time_updated)
  }, 40_000)

  test("快照已覆盖空闲期 → 不入队不重复快照", async () => {
    // 沙箱 3s 前活动，快照 1s 前创建（>= time_updated）：已覆盖
    const sessionID = await insertSession("covered", { sandboxAgeMs: 3_000, snapshotAgeMs: 1_000 })
    await Bun.sleep(1_600)

    expect((await refreshOps(sessionID)).length).toBe(0)
    expect(countRequests("POST", "/v1/sandboxes/sb_covered/snapshots")).toBe(0)
    // 快照表仍只有 seed 一条
    const snaps = await db.select().from(SessionSnapshotTable).where(eq(SessionSnapshotTable.session_id, sessionID)).all()
    expect(snaps.length).toBe(1)
  }, 20_000)

  test("较新的 failed 快照不能阻止补拍", async () => {    const sessionID = await insertSession("failed_latest", { sandboxAgeMs: 3_000, snapshotAgeMs: 10_000 })
    await db
      .insert(SessionSnapshotTable)
      .values({
        id: "snap_failed_latest",
        session_id: sessionID,
        scope: "session",
        state: "failed",
        reason: "simulated failure",
        time_created: Date.now() - 1_000,
        time_updated: Date.now() - 1_000,
      })
      .run()

    const ready = await waitFor(async () => {
      const latest = await getLatestSnapshot(sessionID)
      return latest?.state === "ready" && latest.id !== "snap_failed_latest_seed"
    })
    expect(ready).toBe(true)
    expect(countRequests("POST", "/v1/sandboxes/sb_failed_latest/snapshots")).toBeGreaterThanOrEqual(1)
  }, 30_000)

  test("非快照会话（pvc）→ 不入队", async () => {
    const sessionID = await insertSession("pvc", { persistMode: "pvc", sandboxAgeMs: 3_000 })
    await Bun.sleep(1_600)

    expect((await refreshOps(sessionID)).length).toBe(0)
    expect(countRequests("POST", "/v1/sandboxes/sb_pvc/snapshots")).toBe(0)
  }, 20_000)

  test("未超保鲜间隔的活跃沙箱 → 不入队", async () => {
    const sessionID = await insertSession("fresh", { sandboxAgeMs: 0 })
    await Bun.sleep(1_200)

    expect((await refreshOps(sessionID)).length).toBe(0)
    expect(countRequests("POST", "/v1/sandboxes/sb_fresh/snapshots")).toBe(0)
    expect((await getSandboxRow(sessionID))?.state).toBe("running")
  }, 20_000)

  test("只有旧快照时即使 marker CLEAN 也保守创建新快照", async () => {
    const sessionID = await insertSession("clean", { sandboxAgeMs: 3_000, snapshotAgeMs: 10_000 })
    requests.length = 0
    commandClean = true

    const done = await waitFor(async () => (await refreshOps(sessionID)).some((op) => op.state === "done"))
    expect(done).toBe(true)
    expect(countRequests("POST", "/v1/sandboxes/sb_clean/snapshots")).toBeGreaterThanOrEqual(1)
    expect(countRequests("DELETE", "/v1/sandboxes/sb_clean")).toBe(0)
    expect((await getSandboxRow(sessionID))?.state).toBe("running")
    expect((await execLogSources(sessionID, "snapshot-refresh")).length).toBeGreaterThanOrEqual(1)
    const snaps = await db.select().from(SessionSnapshotTable).where(eq(SessionSnapshotTable.session_id, sessionID)).all()
    expect(snaps.length).toBe(2)
    commandClean = false
  }, 30_000)

  test("沙箱已被平台回收 + 快照落后 → lag 告警 + 行对账收敛为 destroyed", async () => {
    // 快照 ~62min 前（age 超过 max(2×interval=4s, idleReapMs=1h) 告警阈值）、沙箱 3s 前活动（快照落后 → 入队）、平台侧已消失
    const sessionID = await insertSession("gone", { sandboxAgeMs: 3_000, snapshotAgeMs: 3_700_000, alive: false })

    const destroyed = await waitFor(async () => (await getSandboxRow(sessionID))?.state === "destroyed")
    expect(destroyed).toBe(true)
    const warnings = await execLogSources(sessionID, "snapshot-lag-warning")
    expect(warnings.length).toBeGreaterThanOrEqual(1)
    const detail = JSON.parse(warnings[0]!.command)
    expect(detail.cause).toBe("sandbox gone before periodic snapshot")
    expect(detail.latestSnapshotId).toBe("snap_gone_seed")
    expect(detail.snapshotAgeMs).toBeGreaterThan(3_600_000)
  }, 30_000)

  test("沙箱已被平台回收但快照够新 → 收敛且不告警", async () => {
    // 快照 3.5s 前（< 2×interval=4s 不告警）、但早于沙箱最后活动（3s 前）→ 仍会入队触发收敛
    const sessionID = await insertSession("gone_fresh", { sandboxAgeMs: 3_000, snapshotAgeMs: 3_500, alive: false })

    const destroyed = await waitFor(async () => (await getSandboxRow(sessionID))?.state === "destroyed")
    expect(destroyed).toBe(true)
    expect((await execLogSources(sessionID, "snapshot-lag-warning")).length).toBe(0)
  }, 30_000)

  test("destroy 路径：沙箱已死 + 快照落后 → 同样落 lag 告警（cause 区分）", async () => {
    const sessionID = await insertSession("destroy_gone", { sandboxAgeMs: 0, snapshotAgeMs: 3_700_000, alive: false })
    requests.length = 0

    await Effect.runPromise(svc().destroy(sessionID))

    const destroyed = await waitFor(async () => (await getSandboxRow(sessionID))?.state === "destroyed")
    expect(destroyed).toBe(true)
    const warnings = await execLogSources(sessionID, "snapshot-lag-warning")
    expect(warnings.length).toBeGreaterThanOrEqual(1)
    expect(JSON.parse(warnings[0]!.command).cause).toBe("sandbox gone before snapshot")
  }, 30_000)

  test("refresh 与 destroy 共存：refresh 进行中触发 destroy 也能最终销毁", async () => {
    // 活沙箱 + 无快照：先让保鲜轮入队 refresh，随后主动 destroy
    const sessionID = await insertSession("mixed", { sandboxAgeMs: 3_000 })
    commandClean = false

    const enqueued = await waitFor(async () => (await refreshOps(sessionID)).length > 0)
    expect(enqueued).toBe(true)

    await Effect.runPromise(svc().destroy(sessionID))
    const destroyed = await waitFor(async () => (await getSandboxRow(sessionID))?.state === "destroyed", 45_000)
    expect(destroyed).toBe(true)
    // destroy 走快照销毁语义：先 POST snapshots 再 DELETE（或 CLEAN 复用直接 DELETE）
    const snapIdx = indexOfRequest("POST", "/v1/sandboxes/sb_mixed/snapshots")
    const deleteIdx = indexOfRequest("DELETE", "/v1/sandboxes/sb_mixed")
    expect(deleteIdx).toBeGreaterThanOrEqual(0)
    if (snapIdx >= 0) expect(snapIdx).toBeLessThan(deleteIdx)
  }, 90_000)

  test("CAS：扫描窗口内沙箱被活跃使用（time_updated 持续刷新）→ 不入队", async () => {
    const sessionID = await insertSession("cas", { sandboxAgeMs: 3_000 })
    // 模拟活跃使用：持续刷新 time_updated 跨越多个扫描周期（lock 内二次校验应跳过）
    let stop = false
    const refreshing = (async () => {
      while (!stop) {
        await db.update(SandboxTable).set({ time_updated: Date.now() }).where(eq(SandboxTable.session_id, sessionID)).run()
        await Bun.sleep(150)
      }
    })()
    await Bun.sleep(1_500)
    stop = true
    await refreshing

    expect((await refreshOps(sessionID)).length).toBe(0)
    expect(countRequests("POST", "/v1/sandboxes/sb_cas/snapshots")).toBe(0)
    expect((await getSandboxRow(sessionID))?.state).toBe("running")
  }, 20_000)

  test("行状态非 running（killed）→ refresh worker 直接跳过不动行", async () => {
    // 手动构造 killed 行 + 手动入队 refresh：worker 的 dbGet 校验应跳过（不快照、不销毁、不改状态）
    const sessionID = await insertSession("killed_row", { sandboxAgeMs: 3_000 })
    await db.update(SandboxTable).set({ state: "killed" }).where(eq(SandboxTable.session_id, sessionID)).run()
    requests.length = 0
    await db
      .insert(SnapshotRefreshOperationTable)
      .values({
        id: "op_refresh_killed_row",
        session_id: sessionID,
        sandbox_id: "sb_killed_row",
        kind: "snapshot_refresh",
        state: "pending",
        attempts: 0,
        fencing_token: 0,
        time_created: Date.now(),
        time_updated: Date.now(),
      })
      .run()

    const done = await waitFor(async () => (await refreshOps(sessionID)).some((op) => op.state === "done"))
    expect(done).toBe(true)
    expect(countRequests("POST", "/v1/sandboxes/sb_killed_row/snapshots")).toBe(0)
    expect((await getSandboxRow(sessionID))?.state).toBe("killed")
  }, 30_000)

  test("creating 中的快照视为已覆盖 → 不重复入队（startSnapshot 去重兜底）", async () => {
    // 沙箱 3s 前活动，快照 1s 前进入 creating：覆盖判定跳过
    const sessionID = await insertSession("creating", { sandboxAgeMs: 3_000 })
    await db
      .insert(SessionSnapshotTable)
      .values({
        id: "snap_creating_seed",
        session_id: sessionID,
        scope: "session",
        state: "creating",
        time_created: Date.now() - 1_000,
        time_updated: Date.now() - 1_000,
      })
      .run()
    await Bun.sleep(1_600)

    expect((await refreshOps(sessionID)).length).toBe(0)
    expect(countRequests("POST", "/v1/sandboxes/sb_creating/snapshots")).toBe(0)
  }, 20_000)

  test("从未快照 + 沙箱被平台回收 → 也落 lag 告警（latestSnapshotId=null）", async () => {
    const sessionID = await insertSession("gone_nosnap", { sandboxAgeMs: 3_000, alive: false })

    const destroyed = await waitFor(async () => (await getSandboxRow(sessionID))?.state === "destroyed")
    expect(destroyed).toBe(true)
    const warnings = await execLogSources(sessionID, "snapshot-lag-warning")
    expect(warnings.length).toBeGreaterThanOrEqual(1)
    const detail = JSON.parse(warnings[0]!.command)
    expect(detail.cause).toBe("sandbox gone before periodic snapshot")
    expect(detail.latestSnapshotId).toBeNull()
    expect(detail.snapshotAgeMs).toBeNull()
  }, 30_000)

  test("createSnapshot 失败留下 marker 后仍会重拍，不会误复用旧快照", async () => {
    const sessionID = await insertSession("retry", { sandboxAgeMs: 3_000, snapshotAgeMs: 10_000 })
    snapshotCreateFails = true
    commandClean = true

    // 第一次执行：startSnapshot 失败 → 操作 fail 回 pending（attempts=1，退避 30s）。
    // drain 串行执行，前序用例的快照轮询（POLL 5s）会推迟本操作的领取，等待放宽。
    const failed = await waitFor(async () => (await refreshOps(sessionID)).some((op) => op.state === "pending" && op.attempts >= 1), 45_000)
    expect(failed).toBe(true)
    expect(countRequests("POST", "/v1/sandboxes/sb_retry/snapshots")).toBeGreaterThanOrEqual(1)

    // 恢复远端 + 提前退避时间，等 idle reap 循环的 nudge 重新领取
    snapshotCreateFails = false
    await db
      .update(SnapshotRefreshOperationTable)
      .set({ next_retry_at: 1 })
      .where(and(eq(SnapshotRefreshOperationTable.session_id, sessionID), eq(SnapshotRefreshOperationTable.kind, "snapshot_refresh")))
      .run()

    const ready = await waitFor(async () => {
      const latest = await getLatestSnapshot(sessionID)
      const ops = await refreshOps(sessionID)
      return latest?.state === "ready" && latest.id !== "snap_retry_seed" && ops.some((op) => op.state === "done")
    }, 30_000)
    expect(ready).toBe(true)
    expect((await getLatestSnapshot(sessionID))?.id).not.toBe("snap_retry_seed")
    expect(countRequests("POST", "/v1/sandboxes/sb_retry/snapshots")).toBeGreaterThanOrEqual(2)
    const ops = await refreshOps(sessionID)
    expect(ops.some((op) => op.state === "done")).toBe(true)
    expect((await getSandboxRow(sessionID))?.state).toBe("running")
    const doneOp = ops.find((op) => op.state === "done")
    expect(doneOp?.attempts).toBeGreaterThanOrEqual(2)
    commandClean = false
  }, 120_000)

  test("快照卡 Creating → refresh 短超时释放 fence，恢复后重试成功", async () => {
    const sessionID = await insertSession("stuck", { sandboxAgeMs: 3_000 })
    snapshotsStuckCreating = true

    // fence 生效：行进入 snapshotting
    const fenced = await waitFor(async () => (await getSandboxRow(sessionID))?.state === "snapshotting", 15_000)
    expect(fenced).toBe(true)

    // refresh 等待上限 min(120s, snapshotWaitMs=3s)=3s → 超时 fail，fence 释放（行回 running、操作退避 pending）
    const released = await waitFor(async () => {
      const row = await getSandboxRow(sessionID)
      const ops = await refreshOps(sessionID)
      return row?.state === "running" && ops.some((op) => op.state === "pending" && op.attempts >= 1)
    }, 20_000)
    expect(released).toBe(true)
    expect(countRequests("DELETE", "/v1/sandboxes/sb_stuck")).toBe(0)

    // 远端恢复 + 提前退避：重试复用同一 creating 快照（startSnapshot 去重），最终 ready
    snapshotsStuckCreating = false
    await db
      .update(SnapshotRefreshOperationTable)
      .set({ next_retry_at: 1 })
      .where(and(eq(SnapshotRefreshOperationTable.session_id, sessionID), eq(SnapshotRefreshOperationTable.kind, "snapshot_refresh")))
      .run()
    const ready = await waitFor(async () => (await getLatestSnapshot(sessionID))?.state === "ready", 30_000)
    expect(ready).toBe(true)
    const ops = await refreshOps(sessionID)
    expect(ops.some((op) => op.state === "done")).toBe(true)
    expect((await getSandboxRow(sessionID))?.state).toBe("running")
  }, 90_000)

  test("等待重试期间用户恢复活跃 → 重试的空闲校验拒绝再次 fence", async () => {
    const sessionID = await insertSession("active_return", { sandboxAgeMs: 3_000 })
    // 模拟用户返回：先 touch（time_updated=now），再手动入队 refresh 操作
    await db.update(SandboxTable).set({ time_updated: Date.now() }).where(eq(SandboxTable.session_id, sessionID)).run()
    await db
      .insert(SnapshotRefreshOperationTable)
      .values({
        id: "op_refresh_active_return",
        session_id: sessionID,
        sandbox_id: "sb_active_return",
        kind: "snapshot_refresh",
        state: "pending",
        attempts: 0,
        fencing_token: 0,
        time_created: Date.now(),
        time_updated: Date.now(),
      })
      .run()

    // worker 领取 → CAS 空闲校验（time_updated < now-interval）拒绝 → fail 退避，全程不发快照、行保持 running
    const rejected = await waitFor(
      async () => (await refreshOps(sessionID)).some((op) => op.state === "pending" && op.attempts >= 1),
      30_000,
    )
    expect(rejected).toBe(true)
    expect(countRequests("POST", "/v1/sandboxes/sb_active_return/snapshots")).toBe(0)
    expect((await getSandboxRow(sessionID))?.state).toBe("running")
  }, 40_000)

  test("保鲜成功后无实质写入的 touch → 确认式 CLEAN 复用，不重拍", async () => {
    const sessionID = await insertSession("refresh_reuse", { sandboxAgeMs: 3_000 })

    // 第一周期：完整保鲜成功（confirmedSnapshots 记录该快照）
    const ready = await waitFor(async () => (await getLatestSnapshot(sessionID))?.state === "ready")
    expect(ready).toBe(true)
    expect((await getSandboxRow(sessionID))?.state).toBe("running")

    // 模拟无实质写入的活动（如 getOrCreate reconnect 只 touch 不写文件）：
    // 覆盖判定不满足（快照早于 touch）→ 重新入队；worker 侧 confirmed + CLEAN → 跳过重拍
    await db.update(SandboxTable).set({ time_updated: Date.now() }).where(eq(SandboxTable.session_id, sessionID)).run()
    commandClean = true
    requests.length = 0
    const auditsBefore = (await execLogSources(sessionID, "snapshot-refresh")).length

    const done = await waitFor(async () => {
      const ops = await refreshOps(sessionID)
      return ops.filter((op) => op.state === "done").length >= 2
    }, 30_000)
    expect(done).toBe(true)

    // 跳过路径：无新快照创建、无销毁、无新 refresh 审计、快照表仍 1 条；复用落 snapshot-reuse 审计（periodic 区分）
    expect(countRequests("POST", "/v1/sandboxes/sb_refresh_reuse/snapshots")).toBe(0)
    expect(countRequests("DELETE", "/v1/sandboxes/sb_refresh_reuse")).toBe(0)
    expect((await execLogSources(sessionID, "snapshot-refresh")).length).toBe(auditsBefore)
    const reuseAudits = await execLogSources(sessionID, "snapshot-reuse")
    expect(reuseAudits.length).toBeGreaterThanOrEqual(1)
    expect(JSON.parse(reuseAudits[0]!.command).periodic).toBe(true)
    const snaps = (await db.select().from(SessionSnapshotTable).where(eq(SessionSnapshotTable.session_id, sessionID)).all()) as Array<
      { id: string }
    >
    expect(snaps.length).toBe(1)
    expect((await getSandboxRow(sessionID))?.state).toBe("running")
    commandClean = false
  }, 40_000)
})
