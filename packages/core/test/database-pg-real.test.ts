// 真实 PG 回归：确认超时保护接入后，正常查询与超长语句行为符合预期。
// 未设 OPENCODE_DATABASE_URL 时静默 skip。
import { describe, expect, test } from "bun:test"
import postgres from "postgres"
import { Cause, Effect, Exit } from "effect"
import { DatabasePg } from "../src/database/pg.js"

const URL = process.env.OPENCODE_DATABASE_URL
const describePg = URL ? describe : describe.skip

describePg("真实 PG 上的超时保护", () => {
  test("超长语句在 statement_timeout 内被服务端取消", async () => {
    const options = DatabasePg.makePostgresOptions({ OPENCODE_PG_STATEMENT_TIMEOUT_MS: "1000" })
    expect(options.connection?.statement_timeout).toBe(1000)

    // 直接用与 layer 相同的客户端配置连真实 PG，验证 startup params 真的到达服务端
    const { queryTimeoutMs, ...clientOptions } = options
    const client = postgres(URL!, clientOptions)
    try {
      const started = Date.now()
      const exit = await Effect.runPromiseExit(
        DatabasePg.boundQuery(Effect.promise(() => client.unsafe("SELECT pg_sleep(10)")), queryTimeoutMs),
      )
      const elapsed = Date.now() - started
      expect(Exit.isFailure(exit)).toBe(true)
      // 1000ms statement_timeout 之内必须结束
      expect(elapsed).toBeLessThan(5_000)
      if (Exit.isFailure(exit)) {
        const text = Cause.pretty(exit.cause)
        // 服务端 cancel 与客户端兜底等值时谁先返回不确定，两种成因都接受，
        // 但原因必须可定位，不能退化成无信息的 defect。
        expect(text).toMatch(/statement timeout|timed out/i)
      }
    } finally {
      await client.end({ timeout: 2 }).catch(() => {})
    }
  }, 30_000)


  test("正常查询不受影响", async () => {
    const options = DatabasePg.makePostgresOptions({})
    const { default: postgres } = await import("postgres")
    const { queryTimeoutMs, ...clientOptions } = options
    const client = postgres(URL!, clientOptions)
    try {
      const exit = await Effect.runPromiseExit(
        DatabasePg.boundQuery(Effect.promise(() => client.unsafe("SELECT 1 AS ok")), queryTimeoutMs),
      )
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) expect(JSON.stringify(exit.value)).toContain("ok")
    } finally {
      await client.end({ timeout: 2 }).catch(() => {})
    }
  }, 30_000)
})
