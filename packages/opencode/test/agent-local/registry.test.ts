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

  test("bind/unbind：getForSession 命中与未命中", () => {
    const { send } = makeSend()
    const conn = AgentRegistry.instance.register("/tmp/x", send)
    const sid = "ses_test_1"
    Effect.runSync(AgentRegistry.instance.bindSession(sid, conn.id))
    expect(Effect.runSync(AgentRegistry.instance.getForSession(sid))?.id).toBe(conn.id)
    expect(AgentRegistry.instance.list().find((a) => a.agentID === conn.id)?.boundSessions).toContain(sid)

    Effect.runSync(AgentRegistry.instance.unbindSession(sid))
    expect(Effect.runSync(AgentRegistry.instance.getForSession(sid))).toBeNull()
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
    expect(Effect.runSync(AgentRegistry.instance.getForSession(sid))).toBeNull()
    expect(AgentRegistry.instance.list().some((a) => a.agentID === conn.id)).toBe(false)
  })

  test("bindSession 不存在的 agentID 是 no-op", () => {
    Effect.runSync(AgentRegistry.instance.bindSession("ses_x", "agent-none"))
    expect(Effect.runSync(AgentRegistry.instance.getForSession("ses_x"))).toBeNull()
  })
})
