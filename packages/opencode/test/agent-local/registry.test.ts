import { describe, test, expect, beforeEach } from "bun:test"
import { Effect } from "effect"
import { AgentRegistry } from "@/agent-local/registry"

function makeSend() {
  const sent: unknown[] = []
  return { sent, send: (msg: unknown) => sent.push(msg) }
}

describe("AgentRegistry", () => {
  beforeEach(() => {
    for (const a of AgentRegistry.instance.list()) {
      Effect.runSync(AgentRegistry.instance.unregister(a.agentID))
    }
  })

  test("register 返回带 agentID 的连接，list 可见", () => {
    const { send } = makeSend()
    const conn = AgentRegistry.instance.register("/tmp/x", send)
    expect(conn.id).toStartWith("agent-")
    const list = AgentRegistry.instance.list()
    expect(list.some((a) => a.agentID === conn.id && a.workdir === "/tmp/x")).toBe(true)
    Effect.runSync(AgentRegistry.instance.unregister(conn.id))
  })

  test("bind/unbind：getForSession 命中与未命中", async () => {
    const { send } = makeSend()
    const conn = AgentRegistry.instance.register("/tmp/x", send)
    const sid = "ses_test_1"
    Effect.runSync(AgentRegistry.instance.bindSession(sid, conn.id))
    expect((await Effect.runPromise(AgentRegistry.instance.getForSession(sid)))?.id).toBe(conn.id)
    expect(AgentRegistry.instance.list().find((a) => a.agentID === conn.id)?.boundSessions).toContain(sid)

    Effect.runSync(AgentRegistry.instance.unbindSession(sid))
    expect(await Effect.runPromise(AgentRegistry.instance.getForSession(sid))).toBeNull()
    Effect.runSync(AgentRegistry.instance.unregister(conn.id))
  })

  test("unregister：pending 全部 reject，绑定自动清理", async () => {
    const { send } = makeSend()
    const conn = AgentRegistry.instance.register("/tmp/x", send)
    const sid = "ses_test_2"
    Effect.runSync(AgentRegistry.instance.bindSession(sid, conn.id))

    const p1 = new Promise((resolve) => conn.pending.set("req-1", { resolve: () => resolve("ok"), reject: (e) => resolve(e) }))
    const p2 = new Promise((resolve) => conn.pending.set("req-2", { resolve: () => resolve("ok"), reject: (e) => resolve(e) }))

    Effect.runSync(AgentRegistry.instance.unregister(conn.id))

    expect(await p1).toBeInstanceOf(Error)
    expect(await p2).toBeInstanceOf(Error)
    expect(await Effect.runPromise(AgentRegistry.instance.getForSession(sid))).toBeNull()
    expect(AgentRegistry.instance.list().some((a) => a.agentID === conn.id)).toBe(false)
  })

  test("bindSession 不存在的 agentID 是 no-op", async () => {
    Effect.runSync(AgentRegistry.instance.bindSession("ses_x", "agent-none"))
    expect(await Effect.runPromise(AgentRegistry.instance.getForSession("ses_x"))).toBeNull()
  })

  test("改绑 A→B 时旧 Agent 的 boundSessions 被移除（L4.5）", async () => {
    const { send: sendA } = makeSend()
    const { send: sendB } = makeSend()
    const connA = AgentRegistry.instance.register("/tmp/a", sendA)
    const connB = AgentRegistry.instance.register("/tmp/b", sendB)
    const sid = "ses_rebind"
    Effect.runSync(AgentRegistry.instance.bindSession(sid, connA.id))
    Effect.runSync(AgentRegistry.instance.bindSession(sid, connB.id))
    // 新 owner 持有绑定
    expect((await Effect.runPromise(AgentRegistry.instance.getForSession(sid)))?.id).toBe(connB.id)
    // 旧 owner 的 boundSessions 不得残留（否则重连/替换时路由漂移回 A）
    expect(connA.boundSessions.has(sid)).toBe(false)
    expect(connB.boundSessions.has(sid)).toBe(true)
    Effect.runSync(AgentRegistry.instance.unregister(connA.id))
    Effect.runSync(AgentRegistry.instance.unregister(connB.id))
  })

  test("register 替换同 ID 连接时调用旧连接 close（L4.4）", async () => {
    const { send: send1 } = makeSend()
    const conn1 = AgentRegistry.instance.register("/tmp/x", send1, "agent-stable-1")
    let closed = false
    conn1.close = () => {
      closed = true
    }
    const { send: send2 } = makeSend()
    const conn2 = AgentRegistry.instance.register("/tmp/y", send2, "agent-stable-1")
    expect(closed).toBe(true)
    expect((await Effect.runPromise(AgentRegistry.instance.getForSession("ses_z")))).toBeNull()
    Effect.runSync(AgentRegistry.instance.unregister("agent-stable-1"))
    expect(closed).toBe(true)
  })
})
