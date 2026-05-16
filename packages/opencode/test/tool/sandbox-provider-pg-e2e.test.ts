/**
 * sandbox-provider pgLayer 业务逻辑 E2E 测试
 *
 * 完整测试 pgLayer 各方法的业务行为，同时验证 PG 状态持久化。
 * 不 mock Sandbox SDK，直接连真实沙箱。
 *
 * 运行方式：
 *   OPENCODE_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/opencode_test \
 *   OPENCODE_SANDBOX_DOMAIN=172.18.32.15:30040 \
 *   OPENCODE_SANDBOX_IMAGE=registry.shadow-rpa.net/infra/xybot-sandbox-coder:latest \
 *   OPENCODE_SANDBOX_USE_SERVER_PROXY=true \
 *   bun test test/tool/sandbox-provider-pg-e2e.test.ts
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "../../src/storage/db"
import { SandboxTable } from "../../src/tool/sandbox.pg"
import { SandboxProvider, SandboxConfig } from "../../src/tool/sandbox-provider"
import type { SessionID } from "../../src/session/schema"

// E2E 测试超时（沙箱创建需要 10-30s）
const TIMEOUT = 120_000

// ── 前置检查 ──────────────────────────────────────────────────────────

const DB_URL = process.env.OPENCODE_DATABASE_URL
const DOMAIN = process.env.OPENCODE_SANDBOX_DOMAIN
const IMAGE = process.env.OPENCODE_SANDBOX_IMAGE

if (!DB_URL || !DOMAIN || !IMAGE) {
  console.log([
    "跳过 sandbox-provider-pg-e2e 测试，需要设置以下环境变量：",
    "  OPENCODE_DATABASE_URL",
    "  OPENCODE_SANDBOX_DOMAIN",
    "  OPENCODE_SANDBOX_IMAGE",
  ].join("\n"))
  process.exit(0)
}

// ── 运行时 & 辅助 ─────────────────────────────────────────────────────

const configLayer = Layer.succeed(
  SandboxConfig.Service,
  SandboxConfig.Service.of({
    domain: DOMAIN,
    protocol: "http" as const,
    apiKey: process.env.OPENCODE_SANDBOX_API_KEY ?? "",
    useServerProxy: process.env.OPENCODE_SANDBOX_USE_SERVER_PROXY === "true",
    image: IMAGE,
    timeoutSeconds: 300,
    resourceLimits: { cpu: "1", memory: "2Gi" },
    volumeType: "none" as const,
    pvcClaimName: "",
    idleKillMs: 30_000,
    maxTtlSeconds: 3600,
  }),
)

const runtime = ManagedRuntime.make(
  SandboxProvider.pgLayer.pipe(Layer.provide(configLayer)),
)

const db = Database.Client()

const sid = (s: string) => s as SessionID

async function dbGet(sessionID: string) {
  const rows = await db.select().from(SandboxTable).where(eq(SandboxTable.session_id, sessionID)).limit(1)
  return rows[0] ?? null
}

async function dbCleanup(sessionID: string) {
  await db.delete(SandboxTable).where(eq(SandboxTable.session_id, sessionID)).run()
}

function run<A>(effect: Effect.Effect<A, any, SandboxProvider.Service>) {
  return runtime.runPromise(effect)
}

// ── 测试套件 ──────────────────────────────────────────────────────────

describe("pgLayer - get：沙箱不存在时返回 null", () => {
  const SID = sid("ses_e2e_get_null")

  beforeEach(async () => { await dbCleanup(SID) })
  afterEach(async () => { await dbCleanup(SID) })

  test("DB 无记录 → get 返回 null", async () => {
    const result = await run(SandboxProvider.Service.use((svc) => svc.get(SID)))
    expect(result).toBeNull()
  })

  test("DB 记录 state=killed → get 返回 null", async () => {
    await db.insert(SandboxTable).values({
      id: "sb_fake_killed",
      session_id: SID,
      host: "http://localhost:9999",
      state: "killed",
      keep_alive: false,
      command_session_id: null,
      time_created: Date.now(),
      time_updated: Date.now(),
    }).run()

    const result = await run(SandboxProvider.Service.use((svc) => svc.get(SID)))
    expect(result).toBeNull()
  })

  test("DB 记录 state=running 但沙箱不可达 → get 返回 null 且 DB state 置为 killed", async () => {
    await db.insert(SandboxTable).values({
      id: "sb_fake_unreachable",
      session_id: SID,
      host: "http://localhost:9999",
      state: "running",
      keep_alive: false,
      command_session_id: null,
      time_created: Date.now(),
      time_updated: Date.now(),
    }).run()

    const result = await run(SandboxProvider.Service.use((svc) => svc.get(SID)))
    expect(result).toBeNull()

    const row = await dbGet(SID)
    expect(row?.state).toBe("killed")
  })
})

describe("pgLayer - getOrCreate：创建并持久化到 DB", () => {
  const SID = sid("ses_e2e_getorcreate")

  afterEach(async () => {
    // 清理沙箱
    await run(SandboxProvider.Service.use((svc) => svc.destroy(SID))).catch(() => {})
    await dbCleanup(SID)
  })

  test("DB 无记录 → 创建沙箱 + 写入 DB", async () => {
    await dbCleanup(SID)

    const sb = await run(SandboxProvider.Service.use((svc) => svc.getOrCreate(SID)))
    expect(sb).not.toBeNull()

    const row = await dbGet(SID)
    expect(row).not.toBeNull()
    expect(row!.state).toBe("running")
    expect(row!.id).toBe(sb.id)
    expect(row!.session_id).toBe(SID)
  }, TIMEOUT)

  test("DB 有 running 记录 → 重连已有沙箱，不重复创建", async () => {
    await dbCleanup(SID)

    const sb1 = await run(SandboxProvider.Service.use((svc) => svc.getOrCreate(SID)))
    const id1 = sb1.id

    const sb2 = await run(SandboxProvider.Service.use((svc) => svc.getOrCreate(SID)))
    expect(sb2.id).toBe(id1)

    const row = await dbGet(SID)
    expect(row!.id).toBe(id1)
  }, TIMEOUT)

  test("DB state=killed → 重建沙箱", async () => {
    await dbCleanup(SID)

    await run(SandboxProvider.Service.use((svc) => svc.getOrCreate(SID)))
    await db.update(SandboxTable)
      .set({ state: "killed" })
      .where(eq(SandboxTable.session_id, SID))
      .run()

    const sb2 = await run(SandboxProvider.Service.use((svc) => svc.getOrCreate(SID)))
    expect(sb2).not.toBeNull()

    const row = await dbGet(SID)
    expect(row!.state).toBe("running")
  }, TIMEOUT)

  test("并发 getOrCreate 同一 sessionID → 只创建一个沙箱", async () => {
    await dbCleanup(SID)

    const results = await Promise.all([
      run(SandboxProvider.Service.use((svc) => svc.getOrCreate(SID))),
      run(SandboxProvider.Service.use((svc) => svc.getOrCreate(SID))),
      run(SandboxProvider.Service.use((svc) => svc.getOrCreate(SID))),
    ])

    const ids = results.map((sb) => sb.id)
    expect(new Set(ids).size).toBe(1)

    const row = await dbGet(SID)
    expect(row!.state).toBe("running")
  }, TIMEOUT)
})

describe("pgLayer - keepAlive / release / isKeepAlive", () => {
  const SID = sid("ses_e2e_keepalive")

  afterEach(async () => {
    await run(SandboxProvider.Service.use((svc) => svc.destroy(SID))).catch(() => {})
    await dbCleanup(SID)
  })

  test("初始 isKeepAlive = false", async () => {
    await dbCleanup(SID)
    await run(SandboxProvider.Service.use((svc) => svc.getOrCreate(SID)))

    const alive = await run(SandboxProvider.Service.use((svc) => svc.isKeepAlive(SID)))
    expect(alive).toBe(false)

    const row = await dbGet(SID)
    expect(row!.keep_alive).toBe(false)
  }, TIMEOUT)

  test("keepAlive → isKeepAlive = true，DB 同步", async () => {
    await dbCleanup(SID)
    await run(SandboxProvider.Service.use((svc) => svc.getOrCreate(SID)))
    await run(SandboxProvider.Service.use((svc) => svc.keepAlive(SID)))

    const alive = await run(SandboxProvider.Service.use((svc) => svc.isKeepAlive(SID)))
    expect(alive).toBe(true)

    const row = await dbGet(SID)
    expect(row!.keep_alive).toBe(true)
  }, TIMEOUT)

  test("keepAlive → release → isKeepAlive = false，DB 同步", async () => {
    await dbCleanup(SID)
    await run(SandboxProvider.Service.use((svc) => svc.getOrCreate(SID)))
    await run(SandboxProvider.Service.use((svc) => svc.keepAlive(SID)))
    await run(SandboxProvider.Service.use((svc) => svc.release(SID)))

    const alive = await run(SandboxProvider.Service.use((svc) => svc.isKeepAlive(SID)))
    expect(alive).toBe(false)

    const row = await dbGet(SID)
    expect(row!.keep_alive).toBe(false)
  }, TIMEOUT)

  test("沙箱不存在时 isKeepAlive = false", async () => {
    await dbCleanup(SID)
    const alive = await run(SandboxProvider.Service.use((svc) => svc.isKeepAlive(SID)))
    expect(alive).toBe(false)
  })
})

describe("pgLayer - destroy：清理 DB 记录", () => {
  const SID = sid("ses_e2e_destroy")

  afterEach(async () => { await dbCleanup(SID) })

  test("destroy 后 DB 记录删除，get 返回 null", async () => {
    await dbCleanup(SID)
    await run(SandboxProvider.Service.use((svc) => svc.getOrCreate(SID)))
    expect(await dbGet(SID)).not.toBeNull()

    await run(SandboxProvider.Service.use((svc) => svc.destroy(SID)))

    expect(await dbGet(SID)).toBeNull()
    const result = await run(SandboxProvider.Service.use((svc) => svc.get(SID)))
    expect(result).toBeNull()
  }, TIMEOUT)

  test("destroy state=killed 记录 → 直接删除", async () => {
    await dbCleanup(SID)
    await db.insert(SandboxTable).values({
      id: "sb_fake_killed_destroy",
      session_id: SID,
      host: "http://localhost:9999",
      state: "killed",
      keep_alive: false,
      command_session_id: null,
      time_created: Date.now(),
      time_updated: Date.now(),
    }).run()

    await run(SandboxProvider.Service.use((svc) => svc.destroy(SID)))
    expect(await dbGet(SID)).toBeNull()
  })

  test("destroy 不存在的 session → 不抛错", async () => {
    await dbCleanup(SID)
    await expect(
      run(SandboxProvider.Service.use((svc) => svc.destroy(SID)))
    ).resolves.toBeUndefined()
  })
})

describe("pgLayer - register：外部注入沙箱写入 DB", () => {
  const SID = sid("ses_e2e_register")
  const { Sandbox, ConnectionConfig } = require("@alibaba-group/opensandbox")

  afterEach(async () => {
    await run(SandboxProvider.Service.use((svc) => svc.destroy(SID))).catch(() => {})
    await dbCleanup(SID)
  })

  test("register 后 DB 可查到记录，get 返回沙箱", async () => {
    await dbCleanup(SID)

    const conn = new ConnectionConfig({
      domain: DOMAIN,
      protocol: "http",
      apiKey: process.env.OPENCODE_SANDBOX_API_KEY ?? "",
      useServerProxy: process.env.OPENCODE_SANDBOX_USE_SERVER_PROXY === "true",
    })
    const sb = await Sandbox.create({
      connectionConfig: conn,
      image: IMAGE,
      timeoutSeconds: 300,
    })

    await run(SandboxProvider.Service.use((svc) => svc.register(SID, sb)))

    const row = await dbGet(SID)
    expect(row).not.toBeNull()
    expect(row!.id).toBe(sb.id)
    expect(row!.state).toBe("running")

    const got = await run(SandboxProvider.Service.use((svc) => svc.get(SID)))
    expect(got).not.toBeNull()
    expect(got!.id).toBe(sb.id)
  }, TIMEOUT)
})

describe("pgLayer - destroyAll：清理所有 running 沙箱", () => {
  const SID_A = sid("ses_e2e_destroyall_a")
  const SID_B = sid("ses_e2e_destroyall_b")

  afterEach(async () => {
    await dbCleanup(SID_A)
    await dbCleanup(SID_B)
  })

  test("destroyAll 后所有 running 记录被清理", async () => {
    await dbCleanup(SID_A)
    await dbCleanup(SID_B)

    await run(SandboxProvider.Service.use((svc) => svc.getOrCreate(SID_A)))
    await run(SandboxProvider.Service.use((svc) => svc.getOrCreate(SID_B)))

    expect(await dbGet(SID_A)).not.toBeNull()
    expect(await dbGet(SID_B)).not.toBeNull()

    await run(SandboxProvider.Service.use((svc) => svc.destroyAll()))

    expect(await dbGet(SID_A)).toBeNull()
    expect(await dbGet(SID_B)).toBeNull()
  }, TIMEOUT)
})

describe("pgLayer - command_session_id：shell session 持久化", () => {
  const SID = sid("ses_e2e_cmdsession")

  afterEach(async () => {
    await run(SandboxProvider.Service.use((svc) => svc.destroy(SID))).catch(() => {})
    await dbCleanup(SID)
  })

  test("首次 runInSession → DB 写入 command_session_id", async () => {
    await dbCleanup(SID)

    const before = await dbGet(SID)
    expect(before).toBeNull()

    await run(SandboxProvider.Service.use((svc) =>
      svc.runInSession(SID, "echo hello"),
    ))

    const row = await dbGet(SID)
    expect(row).not.toBeNull()
    expect(row!.command_session_id).not.toBeNull()
    expect(typeof row!.command_session_id).toBe("string")
    expect(row!.command_session_id!.length).toBeGreaterThan(0)
  }, TIMEOUT)

  test("第二次 runInSession → 复用同一 command_session_id，跨调用状态保留", async () => {
    await dbCleanup(SID)

    // 第一次：export 环境变量
    await run(SandboxProvider.Service.use((svc) =>
      svc.runInSession(SID, "export E2E_VAR=persistent_value"),
    ))

    const row1 = await dbGet(SID)
    const cmdId1 = row1!.command_session_id

    // 第二次：读取环境变量（验证状态保留）
    const result = await run(SandboxProvider.Service.use((svc) =>
      svc.runInSession(SID, "echo $E2E_VAR"),
    ))
    const out = result.logs.stdout.map((l: any) => l.text).join("").trim()
    expect(out).toBe("persistent_value")

    // DB 里 command_session_id 不变（复用了同一个 shell session）
    const row2 = await dbGet(SID)
    expect(row2!.command_session_id).toBe(cmdId1)
  }, TIMEOUT)

  test("沙箱重建后 command_session_id 重置，不复用旧 shell session", async () => {
    await dbCleanup(SID)

    // 第一次创建 + 建立 shell session
    await run(SandboxProvider.Service.use((svc) =>
      svc.runInSession(SID, "export REBUILD_VAR=before_rebuild"),
    ))

    const row1 = await dbGet(SID)
    const cmdId1 = row1!.command_session_id
    expect(cmdId1).not.toBeNull()

    // 强制将 state 置为 killed，触发 getOrCreate 重建
    await Database.Client()
      .update(SandboxTable)
      .set({ state: "killed", command_session_id: null })
      .where(eq(SandboxTable.session_id, SID))
      .run()

    // 重建后执行命令，应建立新的 shell session
    await run(SandboxProvider.Service.use((svc) =>
      svc.runInSession(SID, "echo new_session"),
    ))

    const row2 = await dbGet(SID)
    // sandbox ID 变了，command_session_id 也是新的
    expect(row2!.id).not.toBe(row1!.id)
    expect(row2!.command_session_id).not.toBeNull()
    expect(row2!.command_session_id).not.toBe(cmdId1)

    // 旧的环境变量不存在（新 shell session）
    const result = await run(SandboxProvider.Service.use((svc) =>
      svc.runInSession(SID, "echo ${REBUILD_VAR:-empty}"),
    ))
    const out = result.logs.stdout.map((l: any) => l.text).join("").trim()
    expect(out).toBe("empty")
  }, TIMEOUT)

  test("destroy 后 DB 记录删除（command_session_id 随之清理）", async () => {
    await dbCleanup(SID)

    await run(SandboxProvider.Service.use((svc) =>
      svc.runInSession(SID, "echo before_destroy"),
    ))

    const row = await dbGet(SID)
    expect(row!.command_session_id).not.toBeNull()

    await run(SandboxProvider.Service.use((svc) => svc.destroy(SID)))

    // DB 记录已删除，command_session_id 随之消失
    expect(await dbGet(SID)).toBeNull()
  }, TIMEOUT)
})
