import { describe, expect, test } from "bun:test"
import { DatabasePg } from "../src/database/pg.js"

// 回归防线：2026-08-21 线上事故（PG 网络抖动 → run 内写挂死 → 会话「发消息不回复」）
// 的四道兜底在 V2 中曾全部缺失：postgres() 没有 connection startup params，
// 客户端查询也没有超时包装。本组用例把它们钉死。
describe("PostgreSQL 超时配置", () => {
  test("默认注入 statement/lock/idle-tx 三条 startup params", () => {
    const options = DatabasePg.makePostgresOptions({})
    expect(options.connection).toBeDefined()
    expect(options.connection?.statement_timeout).toBe(30_000)
    expect(options.connection?.lock_timeout).toBe(30_000)
    expect(options.connection?.idle_in_transaction_session_timeout).toBe(60_000)
  })

  test("connect_timeout 始终存在（保护握手阶段）", () => {
    expect(DatabasePg.makePostgresOptions({}).connect_timeout).toBeGreaterThan(0)
  })

  test("客户端兜底默认等于 statement_timeout（与 V1 一致）", () => {
    const options = DatabasePg.makePostgresOptions({})
    expect(options.queryTimeoutMs).toBe(options.connection?.statement_timeout)
  })

  test("泄漏连接由 idle_timeout / max_lifetime 回收", () => {
    const options = DatabasePg.makePostgresOptions({})
    // V2 池上限为 max:1，被放弃的半开连接必须能被回收
    expect(options.idle_timeout).toBeGreaterThan(0)
    expect(options.max_lifetime).toBeGreaterThan(0)
  })

  test("grace 可显式调大，让客户端兜底宽于服务端", () => {
    const options = DatabasePg.makePostgresOptions({ OPENCODE_PG_QUERY_GRACE_MS: "5000" })
    expect(options.queryTimeoutMs).toBe(35_000)
  })

  test("env 可覆盖 statement_timeout 与 idle-tx 超时", () => {
    const options = DatabasePg.makePostgresOptions({
      OPENCODE_PG_STATEMENT_TIMEOUT_MS: "1000",
      OPENCODE_PG_IDLE_TX_TIMEOUT_MS: "3000",
    })
    expect(options.connection?.statement_timeout).toBe(1000)
    expect(options.connection?.lock_timeout).toBe(1000)
    expect(options.connection?.idle_in_transaction_session_timeout).toBe(3000)
    expect(options.queryTimeoutMs).toBe(1000)
  })

  test("非法 env 回落到默认值，不静默变成 0（0 = 永不超时）", () => {
    const options = DatabasePg.makePostgresOptions({
      OPENCODE_PG_STATEMENT_TIMEOUT_MS: "not-a-number",
      OPENCODE_PG_IDLE_TX_TIMEOUT_MS: "0",
    })
    expect(options.connection?.statement_timeout).toBe(30_000)
    expect(options.connection?.idle_in_transaction_session_timeout).toBe(60_000)
  })

  test("既有的连接池参数未被破坏", () => {
    const options = DatabasePg.makePostgresOptions({})
    expect(options.max).toBe(1)
    expect(options.prepare).toBe(false)
    expect(options.onnotice).toBeDefined()
  })
})
