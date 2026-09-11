/**
 * runDetached 常驻进程保活单元测试（PG + lifecycle mock）
 *
 * 修复背景：runDetached 的 finally 曾无条件 deleteSession，execd 删除 command
 * session 会终止 session 内全部进程——dev server 刚拉起就被杀（exit 137）。
 * SDK 对 detach 命令的语义是「启动即返回」，"returned" ≠ "finished"。
 *
 * 验证：
 * - T1: 命令收到 execution_complete 返回后不再调用 deleteSession（修复核心）
 * - T2: exit 137（SIGKILL/OOM）正常返回 result，不抛错
 * - T3: 执行超时走 TimeoutError 结果路径并 interrupt（原有防御保留）
 *
 * 运行方式：
 *   OPENCODE_DATABASE_URL=postgresql://local@127.0.0.1:5432/opencode_test \
 *   bun test test/tool/sandbox-detached-keepalive.test.ts
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import { like } from "drizzle-orm"
import { Database } from "../../src/storage/db"
import { SandboxTable } from "../../src/tool/sandbox.pg"
import { SandboxProvider, SandboxConfig } from "../../src/tool/sandbox-provider"
import type { SessionID } from "../../src/session/schema"

const DB_URL = process.env.OPENCODE_DATABASE_URL
const enabled = (() => {
  if (!DB_URL) return false
  const url = new URL(DB_URL)
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/opencode_test"
})()

const sid = (s: string) => s as SessionID

// ── lifecycle mock：OpenSandbox API + command session SSE ─────────────
const sessionDeletes: string[] = []
const interrupts: string[] = []
const activeControllers: ReadableStreamDefaultController<Uint8Array>[] = []
let runBehavior: "complete" | "hang" | "exit137" = "complete"
let sessionSeq = 0

const lifecycle = Bun.serve({
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname
    if (request.method === "GET" && path === "/ping") return new Response("ok")
    if (request.method === "POST" && path === "/v1/sandboxes")
      return Response.json({ id: `sb_mock_${Date.now()}`, createdAt: new Date().toISOString() })
    if (request.method === "GET" && /\/v1\/sandboxes\/[^/]+\/endpoints\//.test(path))
      return Response.json({ endpoint: new URL(request.url).host, headers: {} })
    if (request.method === "DELETE" && /\/v1\/sandboxes\//.test(path)) return new Response(null, { status: 200 })
    if (request.method === "POST" && path === "/session") {
      sessionSeq++
      return Response.json({ session_id: `cmd_${sessionSeq}` })
    }
    if (request.method === "POST" && /^\/session\/[^/]+\/run$/.test(path)) {
      const sessionId = path.split("/")[2]
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const enc = new TextEncoder()
            const send = (ev: unknown) => controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`))
            send({ type: "init", text: `exec_${sessionId}` })
            if (runBehavior === "complete") {
              send({ type: "stdout", text: "dev server ready" })
              send({ type: "execution_complete", execution_time: 100 })
              controller.close()
            } else if (runBehavior === "exit137") {
              send({ type: "error", error: { ename: "ExitCode", evalue: "137" } })
              send({ type: "execution_complete", execution_time: 100 })
              controller.close()
            }
            // hang: 流保持打开，模拟常驻进程
            activeControllers.push(controller)
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    }
    if (request.method === "DELETE" && path === "/command") {
      interrupts.push(new URL(request.url).searchParams.get("id") ?? "")
      return new Response(null, { status: 200 })
    }
    if (request.method === "DELETE" && /^\/session\/[^/]+$/.test(path)) {
      sessionDeletes.push(path.split("/")[2])
      return new Response(null, { status: 200 })
    }
    return Response.json({ code: "NOT_FOUND", message: "not found" }, { status: 404 })
  },
})

const configLayer = Layer.succeed(
  SandboxConfig.Service,
  SandboxConfig.Service.of({
    domain: lifecycle.url.host,
    protocol: "http",
    apiKey: "",
    useServerProxy: false,
    image: "fake",
    timeoutSeconds: 300,
    resourceLimits: { cpu: "1", memory: "2Gi" },
    volumeType: "none" as const,
    pvcClaimName: "",
    snapshotImage: "",
    snapshotTtlMs: 7 * 86400_000,
    snapshotWaitMs: 900_000,
    idleKillMs: 3_600_000,
    idleReapMs: 3_600_000,
    idleReapIntervalMs: 60_000,
    maxTtlSeconds: 3600,
    packageCacheMount: "/cache",
    snapshotPrune: false,
    cleanupOnScopeExit: false,
  }),
)

const db = Database.Client()
let scope: Scope.Scope | undefined
let provider: any

async function insertRunningSandbox(sessionID: string) {
  const now = Date.now()
  await db.insert(SandboxTable).values({
    id: `sb_${sessionID}`,
    session_id: sessionID,
    host: `http://${lifecycle.url.host}`,
    state: "running",
    keep_alive: false,
    command_session_id: null,
    time_created: now,
    time_updated: now,
  }).run()
}

async function dbCleanupTests() {
  await db.delete(SandboxTable).where(like(SandboxTable.session_id, "ses_det_%")).run()
}

describe.skipIf(!enabled)("runDetached - 常驻进程 session 保活", () => {
  beforeAll(async () => {
    await Database.initialize()
    await Effect.runPromise(Effect.gen(function* () {
      scope = yield* Scope.make()
      const context = yield* Layer.buildWithScope(SandboxProvider.pgLayer.pipe(Layer.provide(configLayer)), scope)
      provider = Context.get(context as Context.Context<any>, SandboxProvider.Service)
    }))
    await dbCleanupTests()
  }, 30_000)

  afterAll(async () => {
    if (scope) await Effect.runPromise(Scope.close(scope, Exit.void).pipe(Effect.catchCause(() => Effect.void)))
    lifecycle.stop(true)
  })

  test("T1: 命令启动即返回后不删除 command session（修复核心）", async () => {
    runBehavior = "complete"
    sessionDeletes.length = 0
    const SID = sid("ses_det_keep")
    await insertRunningSandbox(SID)

    const result: any = await Effect.runPromise(
      provider.runDetached(SID, "pnpm run dev", { workingDirectory: "/workspace", timeoutSeconds: 10 }),
    )

    expect(result.complete).toBeDefined()
    expect(result.exitCode).toBe(0)
    expect(result.logs.stdout.map((m: any) => m.text).join("")).toContain("dev server ready")
    // 修复点：detached session 不得被 deleteSession（那会杀掉常驻进程）
    expect(sessionDeletes).toEqual([])

    await dbCleanupTests()
  }, 30_000)

  test("T2: exit 137（SIGKILL/OOM）正常返回 result 而非抛错", async () => {
    runBehavior = "exit137"
    sessionDeletes.length = 0
    const SID = sid("ses_det_oom")
    await insertRunningSandbox(SID)

    const result: any = await Effect.runPromise(
      provider.runDetached(SID, "memory-hungry-command", { workingDirectory: "/workspace", timeoutSeconds: 10 }),
    )

    // error 事件到达时 runCommandEarlyExit 提前返回（不等 execution_complete）
    expect(result.exitCode).toBe(137)
    expect(result.error?.name).toBe("ExitCode")
    expect(sessionDeletes).toEqual([])

    await dbCleanupTests()
  }, 30_000)

  test("T3: 执行超时走 TimeoutError 结果路径并 interrupt（原有防御保留）", async () => {
    runBehavior = "hang"
    sessionDeletes.length = 0
    interrupts.length = 0
    const SID = sid("ses_det_timeout")
    await insertRunningSandbox(SID)

    const result: any = await Effect.runPromise(
      provider.runDetached(SID, "hang-forever", { workingDirectory: "/workspace", timeoutSeconds: 1 }),
    )

    expect(result.error?.name).toBe("TimeoutError")
    expect(result.exitCode).toBeNull()
    // 超时后必须 interrupt 挂住的 session
    expect(interrupts.length).toBe(1)

    for (const c of activeControllers) {
      try { c.close() } catch {}
    }
    activeControllers.length = 0
    await dbCleanupTests()
  }, 30_000)
})
