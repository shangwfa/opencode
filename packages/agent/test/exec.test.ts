import { describe, test, expect } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentHandler } from "../src/handler"
import { PathMapper } from "../src/path"
import type { AgentMessage } from "../src/protocol"

// AgentHandler exec 行为回归：输出上限实时终止、重复 ID 拒绝、
// interrupt grace 升级 SIGKILL、后台子进程不残留。
// 涉及真实进程与秒级等待，各用例显式放宽 timeout。

const root = mkdtempSync(join(tmpdir(), "agent-exec-test-"))

function makeHandler() {
  const sent: AgentMessage[] = []
  const h = new AgentHandler(new PathMapper(root), (m) => sent.push(m))
  return { h, sent }
}

function lastOf(sent: AgentMessage[], id: string, type: string) {
  for (let i = sent.length - 1; i >= 0; i--) {
    const m = sent[i]!
    if (m.id === id && m.type === type) return m
  }
  return undefined
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("AgentHandler exec 资源与进程管理", () => {
  test(
    "运行期输出上限：yes 被 SIGKILL 终止并返回 TruncatedError（L3.2）",
    async () => {
      const { h, sent } = makeHandler()
      const id = "t-trunc"
      await h.handle({ id, type: "exec", req: { sessionID: "ses_trunc", cwd: "/workspace", command: "yes spam", timeoutMs: 60_000 } })
      // 上限 10MB，yes 产出极快；等 finish 到达
      for (let i = 0; i < 200 && !lastOf(sent, id, "exec.result"); i++) await sleep(100)
      const result = lastOf(sent, id, "exec.result") as { res: { logs: { stdout: { text: string }[] }; error?: { name: string } } } | undefined
      expect(result).toBeDefined()
      expect(result!.res.error?.name).toBe("TruncatedError")
      const total = result!.res.logs.stdout.reduce((n, x) => n + x.text.length, 0)
      expect(total).toBeLessThanOrEqual(10 * 1024 * 1024 + 64 * 1024) // 上限 + 单 chunk 余量
    },
    30_000,
  )

  test("重复请求 ID 被拒绝，不覆盖活跃 exec（L3.5）", async () => {
    const { h, sent } = makeHandler()
    await h.handle({ id: "dup", type: "exec", req: { sessionID: "ses_dup", cwd: "/workspace", command: "sleep 0.5" } })
    await h.handle({ id: "dup", type: "exec", req: { sessionID: "ses_dup", cwd: "/workspace", command: "echo second" } })
    const err = sent.find((m) => m.type === "error")
    expect(err).toBeDefined()
    await sleep(800)
    const results = sent.filter((m) => m.type === "exec.result" && m.id === "dup")
    expect(results.length).toBe(1) // 只有第一个请求有结果，第二个被显式拒绝
  })

  test(
    "忽略 SIGINT 的进程：interrupt 后 grace 升级 SIGKILL（L3.3）",
    async () => {
      const { h, sent } = makeHandler()
      const id = "t-trap"
      await h.handle({ id, type: "exec", req: { sessionID: "ses_trap", cwd: "/workspace", command: "trap '' INT TERM; while :; do :; done", timeoutMs: 120_000 } })
      await sleep(500)
      await h.handle({ id, type: "interrupt" })
      expect(lastOf(sent, id, "interrupted")).toBeDefined()
      // grace 5s 后 SIGKILL → exit 事件 → finish
      for (let i = 0; i < 90 && !lastOf(sent, id, "exec.result"); i++) await sleep(100)
      expect(lastOf(sent, id, "exec.result")).toBeDefined()
      h.dispose()
    },
    15_000,
  )

  test("正常退出后后台子进程不残留（L3.4）", async () => {
    const { h, sent } = makeHandler()
    const id = "t-orphan"
    await h.handle({ id, type: "exec", req: { sessionID: "ses_orphan", cwd: "/workspace", command: "(sleep 300 &) ; echo done" } })
    for (let i = 0; i < 50 && !lastOf(sent, id, "exec.result"); i++) await sleep(100)
    await sleep(500)
    const out = Bun.spawnSync(["pgrep", "-f", "sleep 300"])
    expect(out.stdout.toString().trim()).toBe("")
  })

  test("dispose 清理全部在途进程", async () => {
    const { h } = makeHandler()
    await h.handle({ id: "d1", type: "exec", req: { sessionID: "ses_dispose", cwd: "/workspace", command: "sleep 60", timeoutMs: 120_000 } })
    await sleep(300)
    h.dispose()
    await sleep(300)
    const out = Bun.spawnSync(["pgrep", "-f", "sleep 60"])
    expect(out.stdout.toString().trim()).toBe("")
  })
})

// 清理测试根目录（可能残留会话目录）
process.on("exit", () => {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {}
})
