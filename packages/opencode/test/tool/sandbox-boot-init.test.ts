/**
 * 沙箱 boot 初始化命令单元测试（PG + lifecycle mock）
 *
 * 修复背景：pnpm 在 HOME 与 /workspace 跨文件系统时把 store 落进
 * /workspace/.pnpm-store（硬链接需同盘），业务 .gitignore 普遍缺该条目，
 * untracked 爆炸导致 vcs diff 502。createSandbox 的初始化命令现在负责：
 * 1) store 指向 /home/sandbox/.pnpm-store（同 PVC、git 不可见）
 * 2) 全局 excludesfile 兜底（不侵入业务 .gitignore）
 * 3) 旧 store 残留迁移/后台清理
 *
 * 验证：
 * - T1: createSandbox 发出的初始化命令包含全部防御配置
 * - T2: 命令段用 "; " 连接而非 "&&"（前段失败不得中断后续配置）
 *
 * 运行方式：
 *   OPENCODE_DATABASE_URL=postgresql://local@127.0.0.1:5432/opencode_test \
 *   bun test test/tool/sandbox-boot-init.test.ts
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

// ── lifecycle mock：捕获所有经 /session/:id/run 下发的命令 ─────────────
const runCommands: string[] = []
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
    if (request.method === "POST" && path === "/command") {
      const body: any = await request.json().catch(() => ({}))
      runCommands.push(body.command ?? "")
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const enc = new TextEncoder()
            const send = (ev: unknown) => controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`))
            send({ type: "init", text: `exec_${sessionSeq}` })
            send({ type: "stdout", text: "ok" })
            send({ type: "execution_complete", execution_time: 10 })
            controller.close()
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    }
    if (request.method === "POST" && path === "/session") {
      sessionSeq++
      return Response.json({ session_id: `cmd_${sessionSeq}` })
    }
    if (request.method === "POST" && /^\/session\/[^/]+\/run$/.test(path)) {
      const body: any = await request.json().catch(() => ({}))
      runCommands.push(body.command ?? "")
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const enc = new TextEncoder()
            const send = (ev: unknown) => controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`))
            send({ type: "init", text: `exec_${sessionSeq}` })
            send({ type: "stdout", text: "ok" })
            send({ type: "execution_complete", execution_time: 10 })
            controller.close()
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    }
    if (request.method === "DELETE" && /^\/session\/[^/]+$/.test(path)) return new Response(null, { status: 200 })
    if (request.method === "DELETE" && path === "/command") return new Response(null, { status: 200 })
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
    cleanupOnScopeExit: false,
  }),
)

const db = Database.Client()
let scope: Scope.Scope | undefined
let provider: any

describe.skipIf(!enabled)("createSandbox - boot 初始化命令（pnpm store 迁出 git 树）", () => {
  beforeAll(async () => {
    await Database.initialize()
    await Effect.runPromise(Effect.gen(function* () {
      scope = yield* Scope.make()
      const context = yield* Layer.buildWithScope(SandboxProvider.pgLayer.pipe(Layer.provide(configLayer)), scope)
      provider = Context.get(context as Context.Context<any>, SandboxProvider.Service)
    }))
    await db.delete(SandboxTable).where(like(SandboxTable.session_id, "ses_bootinit_%")).run()
  }, 30_000)

  afterAll(async () => {
    if (scope) await Effect.runPromise(Scope.close(scope, Exit.void).pipe(Effect.catchCause(() => Effect.void)))
    lifecycle.stop(true)
  })

  test("T1: 初始化命令只含 git 性能与 excludesfile 兜底，不配置 pnpm store", async () => {
    runCommands.length = 0
    // SandboxTable 无记录 → ensure 走 createSandbox 全流程
    const result: any = await Effect.runPromise(
      provider.runDetached(sid("ses_bootinit_t1"), "true", { workingDirectory: "/workspace", timeoutSeconds: 10 }),
    )
    expect(result.complete).toBeDefined()

    const initCmd = runCommands.find((c) => c.includes("core.excludesfile"))
    expect(initCmd).toBeDefined()

    // 不写 store-dir：pnpm 跨 FS fallback 让 store 落 /workspace/.pnpm-store（同盘硬链接最快）；
    // 指到共享挂载会 EXDEV 退化 copy 模式（比下载慢）且存量元数据不匹配触发 NO_TTY purge 中止
    expect(initCmd).not.toContain("store-dir=")
    expect(initCmd).not.toContain("/root/.npmrc")
    // 不做 node_modules 迁移/清理（store 位置未变，存量元数据天然一致）
    expect(initCmd).not.toContain("node_modules")
    expect(initCmd).not.toContain("rm -rf /workspace/.pnpm-store")
    // excludesfile 兜底（不侵入业务 .gitignore）
    expect(initCmd).toContain("git config --global core.excludesfile /home/sandbox/.gitignore-global")
    expect(initCmd).toContain("printf '.pnpm-store/\\n' > /home/sandbox/.gitignore-global")
    // 原有 git 性能配置保留
    expect(initCmd).toContain("git config --global core.fsmonitor true")
    expect(initCmd).toContain("git config --global core.untrackedcache true")
  }, 30_000)

  test("T2: 命令段用 \"; \" 连接而非 \"&&\"（前段失败不得中断后续配置）", async () => {
    runCommands.length = 0
    await Effect.runPromise(
      provider.runDetached(sid("ses_bootinit_t2"), "true", { workingDirectory: "/workspace", timeoutSeconds: 10 }),
    )
    const initCmd = runCommands.find((c) => c.includes("core.excludesfile"))
    expect(initCmd).toBeDefined()
    // 5 个配置段全部以 "; " 连接（前段失败不得中断后续配置）
    expect(initCmd!.split("; ")).toHaveLength(5)
    // 配置段之间不得用 "&&" 短路
    expect(initCmd).not.toContain("&&")
    expect(initCmd).toContain("; git config --global core.excludesfile")
  }, 30_000)
})
