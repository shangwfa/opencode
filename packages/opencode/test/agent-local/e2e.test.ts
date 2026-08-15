import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { mkdtempSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { homedir } from "node:os"
import { AgentRegistry } from "@/agent-local/registry"
import { LocalAgentChannel } from "@/agent-local/channel"
import { Effect } from "effect"
import { createServer } from "node:http"
import { attachAgentWs } from "@/agent-local/ws"

// 真实 Agent 进程 E2E：覆盖 SaaS ws 层 ↔ Agent handler 的完整链路
// （非 mock）。需要 bun 可执行、unix 环境（与 agent 包一致）。
// 运行：cd packages/opencode && bun test test/agent-local/e2e.test.ts

// Agent 入口：从测试文件位置向仓库根上溯定位 packages/agent（兼容 dist/源码两种布局）
function findAgentEntry(): string {
  let dir = import.meta.dir
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(dir, "packages/agent/src/index.ts")
    if (existsSync(candidate)) return candidate
    const parent = resolve(dir, "..")
    if (parent === dir) break
    dir = parent
  }
  throw new Error("packages/agent/src/index.ts not found from " + import.meta.dir)
}
const AGENT_ENTRY = findAgentEntry()
const ROOT = mkdtempSync(join(tmpdir(), "agent-e2e-"))
const AGENT_ID = `agent-e2e-${Date.now()}`
let agent: ChildProcess | null = null
let wsPort = 0

beforeAll(async () => {
  const server = createServer()
  attachAgentWs(server)
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  wsPort = (server.address() as { port: number }).port

  agent = spawn("bun", ["run", AGENT_ENTRY, "--server", `ws://127.0.0.1:${wsPort}/agent-ws`, "--cwd", ROOT], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, AGENT_ID_OVERRIDE: AGENT_ID },
  })
  agent.stderr?.on("data", (d) => console.error("[agent-e2e]", d.toString().trim()))
  // 等 Agent 注册（registry 出现该 ID）
  for (let i = 0; i < 60 && !AgentRegistry.instance.list().some((a) => a.agentID === AGENT_ID); i++) {
    await Bun.sleep(200)
  }
})

afterAll(() => {
  agent?.kill("SIGKILL")
  rmSync(ROOT, { recursive: true, force: true })
})

const run = <A, E>(eff: Effect.Effect<A, E>) => Effect.runPromise(eff)

describe("LocalAgent E2E（真实 Agent 进程）", () => {
  test("Agent 以指定稳定 ID 注册", () => {
    expect(AgentRegistry.instance.list().some((a) => a.agentID === AGENT_ID)).toBe(true)
  })

  test("exec 全链路：echo 经 ws 到 Agent 进程再返回", async () => {
    const SID = "ses_e2e_exec"
    const conn = AgentRegistry.instance.list().find((a) => a.agentID === AGENT_ID)!
    Effect.runSync(AgentRegistry.instance.bindSession(SID, AGENT_ID))
    const result = await run(LocalAgentChannel.instance.exec(SID, { sessionID: SID, cwd: "/workspace", command: "echo hello-e2e && pwd" }))
    expect(result.exitCode).toBe(0)
    expect(result.logs.stdout.map((x) => x.text).join("")).toContain("hello-e2e")
    expect(result.logs.stdout.map((x) => x.text).join("")).toContain(join(ROOT, "sessions", SID))
    Effect.runSync(AgentRegistry.instance.unbindSession(SID))
  })

  test("rg | head 不挂死（socketpair 回归，端到端）", async () => {
    const SID = "ses_e2e_rg"
    Effect.runSync(AgentRegistry.instance.bindSession(SID, AGENT_ID))
    await run(LocalAgentChannel.instance.exec(SID, { sessionID: SID, cwd: "/workspace", command: "echo needle > f.txt" }))
    const result = await run(
      LocalAgentChannel.instance.exec(SID, { sessionID: SID, cwd: "/workspace", command: "rg -l needle | head -3", timeoutMs: 10_000 }),
    )
    expect(result.error?.name).not.toBe("TimeoutError")
    expect(result.exitCode).toBe(0)
    Effect.runSync(AgentRegistry.instance.unbindSession(SID))
  }, 20_000)

  test("fs.write → 本地落盘；session.cleanup → 目录回收", async () => {
    const SID = "ses_e2e_cleanup"
    Effect.runSync(AgentRegistry.instance.bindSession(SID, AGENT_ID))
    await run(LocalAgentChannel.instance.fsWrite(SID, { sessionID: SID, entries: [{ path: "/workspace/x.txt", data: "bye" }] }))
    expect(existsSync(join(ROOT, "sessions", SID, "x.txt"))).toBe(true)
    await run(LocalAgentChannel.instance.cleanupSession(SID))
    expect(existsSync(join(ROOT, "sessions", SID))).toBe(false)
    Effect.runSync(AgentRegistry.instance.unbindSession(SID))
  })

  test("超时请求返回 TimeoutError 且带 agent 终止", async () => {
    const SID = "ses_e2e_timeout"
    Effect.runSync(AgentRegistry.instance.bindSession(SID, AGENT_ID))
    const t0 = Date.now()
    const result = await run(
      LocalAgentChannel.instance.exec(SID, { sessionID: SID, cwd: "/workspace", command: "sleep 30", timeoutMs: 2_000 }),
    )
    expect(Date.now() - t0).toBeLessThan(10_000)
    expect(result.error?.name).toBe("TimeoutError")
    Effect.runSync(AgentRegistry.instance.unbindSession(SID))
  }, 15_000)
})
