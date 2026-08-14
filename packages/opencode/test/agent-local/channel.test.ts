import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import { LocalAgentChannel } from "@/agent-local/channel"
import { AgentRegistry } from "@/agent-local/registry"

const SESSION = "ses_channel_test"

function registerAgent() {
  const sent: Array<{ id: string; type: string; [k: string]: unknown }> = []
  const conn = AgentRegistry.instance.register("/tmp/x", (msg) => sent.push(msg as never))
  Effect.runSync(AgentRegistry.instance.bindSession(SESSION, conn.id))
  return { conn, sent }
}

function settle(conn: ReturnType<typeof registerAgent>["conn"], id: string, data: unknown) {
  conn.pending.get(id)?.resolve(data)
}

describe("LocalAgentChannel", () => {
  test("未绑定会话：isAvailable=false，请求失败", async () => {
    expect(await Effect.runPromise(LocalAgentChannel.instance.isAvailable("ses_none"))).toBe(false)
    const result = await Effect.runPromiseExit(
      LocalAgentChannel.instance.exec("ses_none", { sessionID: "ses_none", cwd: "/workspace", command: "true" }),
    )
    expect(result._tag).toBe("Failure")
  })

  test("exec：pending 建立、resolve 正常返回 CommandExecution", async () => {
    const { conn, sent } = registerAgent()
    try {
      const promise = Effect.runPromise(
        LocalAgentChannel.instance.exec(SESSION, { sessionID: SESSION, cwd: "/workspace", command: "echo hi" }),
      )
      // 等待请求入队并出现在 pending 表
      let reqID: string | undefined
      for (let i = 0; i < 50 && !reqID; i++) {
        await Bun.sleep(10)
        reqID = sent.find((m) => m.type === "exec")?.id
      }
      expect(reqID).toBeDefined()
      expect(conn.pending.has(reqID!)).toBe(true)

      // 模拟 agent 响应
      settle(conn, reqID!, { logs: { stdout: [{ text: "hi" }], stderr: [] }, exitCode: 0 })

      const result = await promise
      expect(result.exitCode).toBe(0)
      expect(result.logs.stdout[0]?.text).toBe("hi")
    } finally {
      Effect.runSync(AgentRegistry.instance.unregister(conn.id))
    }
  })

  test("settled 守卫：resolve 后迟到的 reject 不抛 defect", async () => {
    const { conn } = registerAgent()
    try {
      const controller = new AbortController()
      const exitPromise = Effect.runPromiseExit(
        LocalAgentChannel.instance.exec(SESSION, { sessionID: SESSION, cwd: "/workspace", command: "sleep 1" }, undefined, controller.signal),
      )
      await Bun.sleep(20)
      const reqID = Array.from(conn.pending.keys())[0]!
      // abort 先触发 reject
      controller.abort()
      const exit = await exitPromise
      expect(exit._tag).toBe("Failure")
      // 模拟 Agent 迟到的响应：同一 pending 已删除，不应有任何崩溃路径
      expect(conn.pending.has(reqID)).toBe(false)
    } finally {
      Effect.runSync(AgentRegistry.instance.unregister(conn.id))
    }
  })

  test("interruptSession：向活跃 exec 发送 interrupt", async () => {
    const { conn, sent } = registerAgent()
    try {
      const exitPromise = Effect.runPromiseExit(
        LocalAgentChannel.instance.exec(SESSION, { sessionID: SESSION, cwd: "/workspace", command: "sleep 10" }),
      )
      await Bun.sleep(20)
      const req = sent.find((m) => m.type === "exec")!
      Effect.runSync(LocalAgentChannel.instance.interruptSession(SESSION))
      const interrupt = sent.find((m) => m.type === "interrupt" && m.id === req.id)
      expect(interrupt).toBeDefined()
      // 模拟 agent 确认中断 → interrupted resolve
      conn.pending.get(req.id)?.resolve({ interrupted: true })
      const exit = await exitPromise
      expect(exit._tag).toBe("Success")
    } finally {
      Effect.runSync(AgentRegistry.instance.unregister(conn.id))
    }
  })
})
