/**
 * bus-bridge 跨 Pod 事件桥单元测试
 *
 * 验证（真实 PG LISTEN/NOTIFY，本地 opencode_test 库）：
 * - 本地 GlobalBus 事件被发布到 PG 频道（信封带 origin）
 * - 自己发布的 event 不会再注入本地 GlobalBus（回环抑制）
 * - 远端 origin 的 event 注入本地 GlobalBus 且带 marker
 * - 带 marker 的本地事件不再被发布（二次回环抑制）
 * - 超过 PG NOTIFY 载荷上限的事件被跳过
 *
 * 运行方式：
 *   OPENCODE_DATABASE_URL=postgresql://local@127.0.0.1:5432/opencode_test \
 *   bun test test/bus/bus-bridge.test.ts
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { PgNotify } from "../../src/bus/pg-notify"
import { BusBridge } from "../../src/bus/bus-bridge"
import { Database } from "../../src/storage/db"

const DB_URL = process.env.OPENCODE_DATABASE_URL
const enabled = (() => {
  if (!DB_URL) return false
  const url = new URL(DB_URL)
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/opencode_test"
})()

const received: unknown[] = []
let busEvents: GlobalEvent[] = []

beforeAll(async () => {
  if (!enabled) return
  await Database.initialize()
  await BusBridge.startBusBridge()
  PgNotify.subscribe((message) => {
    received.push(message)
  })
  GlobalBus.on("event", (event) => {
    // 只记录桥注入路径产生的事件（排除测试自己 emit 的原始事件）
    if ((event as any).__fromPgBridge) busEvents.push(event)
  })
})

afterAll(async () => {
  await BusBridge.stopBusBridge().catch(() => {})
})

function waitUntil(pred: () => boolean, timeoutMs = 5000) {
  return new Promise<boolean>((resolve) => {
    const start = Date.now()
    const timer = setInterval(() => {
      if (pred()) {
        clearInterval(timer)
        resolve(true)
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer)
        resolve(false)
      }
    }, 50)
  })
}

describe.skipIf(!enabled)("bus-bridge", () => {
  test("local GlobalBus events are published to PG with origin", async () => {
    GlobalBus.emit("event", { directory: "t", payload: { type: "test.local", properties: { v: 1 } } })
    expect(
      await waitUntil(() => received.some((m: any) => m?.type === "event" && m.event?.payload?.type === "test.local")),
    ).toBe(true)
    const env: any = received.find((m: any) => m?.type === "event" && m.event?.payload?.type === "test.local")
    expect(env.origin).toBe(BusBridge._podId())
  })

  test("own published events are not re-emitted locally (loop suppression)", async () => {
    busEvents = []
    GlobalBus.emit("event", { directory: "t", payload: { type: "test.loop", properties: {} } })
    await new Promise((r) => setTimeout(r, 800))
    expect(busEvents.filter((e) => e.payload.type === "test.loop")).toHaveLength(0)
  })

  test("remote-origin events are injected into local GlobalBus with marker", async () => {
    busEvents = []
    await PgNotify.publish({ type: "event", origin: "pod-other", event: { directory: "t", payload: { type: "test.remote", properties: { v: 2 } } } })
    expect(
      await waitUntil(() => busEvents.some((e) => e.payload.type === "test.remote")),
    ).toBe(true)
    const event: any = busEvents.find((e) => e.payload.type === "test.remote")
    expect(event.__fromPgBridge).toBe(true)
  })

  test("routes an exec kill notification to the owner pod callback", async () => {
    const killed: string[] = []
    const unsubscribe = BusBridge.subscribeExecKill((execID) => { killed.push(execID) })
    await PgNotify.publish({ type: "exec.kill", origin: "pod-other", execID: "exec-test", sessionID: "sess-test" })
    expect(await waitUntil(() => killed.includes("exec-test"))).toBe(true)
    unsubscribe()
  })

  test("marked local events are not re-published", async () => {
    received.length = 0
    const event: any = { directory: "t", payload: { type: "test.marked", properties: {} }, __fromPgBridge: true }
    GlobalBus.emit("event", event)
    await new Promise((r) => setTimeout(r, 600))
    expect(received.some((m: any) => m?.type === "event" && m.event?.payload?.type === "test.marked")).toBe(false)
  })

  test("oversized events are skipped", async () => {
    received.length = 0
    GlobalBus.emit("event", { directory: "t", payload: { type: "test.big", properties: { blob: "x".repeat(8000) } } })
    await new Promise((r) => setTimeout(r, 600))
    expect(received.some((m: any) => m?.type === "event" && m.event?.payload?.type === "test.big")).toBe(false)
  })

  test("counts UTF-8 bytes when enforcing the NOTIFY limit", async () => {
    received.length = 0
    GlobalBus.emit("event", { directory: "t", payload: { type: "test.big-utf8", properties: { blob: "中".repeat(3000) } } })
    await Bun.sleep(600)
    expect(received.some((m: any) => m?.type === "event" && m.event?.payload?.type === "test.big-utf8")).toBe(false)
  })

  test("loads an oversized remote event through its PG reference", async () => {
    busEvents = []
    await PgNotify.storeLargeEvent(`large-${Date.now()}`, "pod-other", {
      directory: "t",
      payload: { type: "test.big-remote", properties: { blob: "中".repeat(3000) } },
    })
    expect(await waitUntil(() => busEvents.some((event) => event.payload.type === "test.big-remote"))).toBe(true)
  })

  test("recovers a missed dispose notification from the durable revision", async () => {
    const disposed: string[] = []
    const unsubscribe = BusBridge.subscribeDispose((reason) => { disposed.push(reason) })
    const client = (Database.Client() as any).$client
    await client`INSERT INTO cluster_state (key, revision, data, time_updated)
      VALUES ('auth', 1, NULL, ${Date.now()})
      ON CONFLICT (key) DO UPDATE SET revision = cluster_state.revision + 1, time_updated = EXCLUDED.time_updated`
    expect(await waitUntil(() => disposed.includes("auth"), 8000)).toBe(true)
    unsubscribe()
  }, 10_000)

  test("recovers a missed cross-pod abort from the durable generation", async () => {
    const aborted: string[] = []
    const sessionID = `sess_abort_${Date.now()}`
    const unsubscribe = BusBridge.subscribeSessionAbort((id) => { aborted.push(id) })
    const client = (Database.Client() as any).$client
    // Establish the baseline first, then update without sending NOTIFY.
    await client`INSERT INTO session_abort (session_id, directory, generation, time_updated)
      VALUES (${sessionID}, '/tmp/abort-test', 1, ${Date.now()})`
    await Bun.sleep(5_200)
    await client`UPDATE session_abort SET generation = 2, time_updated = ${Date.now()} WHERE session_id = ${sessionID}`
    expect(await waitUntil(() => aborted.includes(sessionID), 8000)).toBe(true)
    unsubscribe()
  }, 15_000)
})
