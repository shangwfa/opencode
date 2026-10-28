import { describe, expect, it, beforeAll, afterAll } from "bun:test"
import "./setup.js"

describe("ConfigChangeBus（LISTEN/NOTIFY 替代 Nacos 推送）", () => {
  type NotifyModule = typeof import("../src/hosting/notify.js")
  let ConfigChangeBus: NotifyModule["ConfigChangeBus"]
  let bus: InstanceType<NotifyModule["ConfigChangeBus"]>
  let connectionString: string

  beforeAll(async () => {
    ;({ ConfigChangeBus } = await import("../src/hosting/notify.js"))
    ;({ connectionString } = await import("../src/db/index.js"))
  })

  afterAll(async () => {
    await bus?.stop()
  })

  it("发布变更后监听方收到通知", async () => {
    bus = new ConfigChangeBus({ connectionString })
    const received: unknown[] = []
    const off = bus.onChange((change) => received.push(change))
    const invalidatedAll: number[] = []
    bus.onInvalidateAll(() => invalidatedAll.push(1))

    await bus.start()
    // start 时会触发一次全量失效（对齐"重建后弥补离线变更"语义）
    expect(invalidatedAll.length).toBeGreaterThanOrEqual(1)

    const { pool } = await import("../src/db/index.js")
    await ConfigChangeBus.publish(pool, { table: "apps", key: "app-a" })
    await ConfigChangeBus.publish(pool, { table: "gray_features", key: "*" })

    // NOTIFY 是异步投递，轮询等待
    for (let i = 0; i < 50 && received.length < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(received).toEqual([
      { table: "apps", key: "app-a" },
      { table: "gray_features", key: "*" },
    ])
    off()
  })

  it("非法 payload 触发全量失效而非崩溃", async () => {
    const { pool } = await import("../src/db/index.js")
    const invalidateAll: number[] = []
    const bus2 = new ConfigChangeBus({ connectionString })
    bus2.onInvalidateAll(() => invalidateAll.push(1))
    await bus2.start()
    const before = invalidateAll.length

    await pool.query(`SELECT pg_notify('gateway_config_changed', $1)`, ["not-json"])

    for (let i = 0; i < 50 && invalidateAll.length <= before; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(invalidateAll.length).toBe(before + 1)
    await bus2.stop()
  })
})
