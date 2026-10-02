import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { DatabasePg } from "../src/database/pg.js"

// 决定性回归：postgres.js 没有 socket 级读写超时。连接握手完成后若网络抖动
// 导致 socket 半开（TCP 存活但数据不通），查询会永久挂起 ——
// 服务端 statement_timeout 收不到请求，connect_timeout 仅保护握手，
// 两者都挡不住。必须有客户端超时兜底。
describe("PostgreSQL 客户端查询超时", () => {
  // 保留 error channel：只写 Effect.Effect<A> 会把错误类型抹成 never，
  // 使泛型推断失准（表现为超时断言跑到 bun 的 5s 用例上限）。
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseExit(effect)

  test("挂死的查询在超时后失败，而不是永久挂起", async () => {
    const hanging = Effect.promise(
      () => new Promise<never>(() => {}), // 永不 settle，模拟半开连接
    )
    const exit = await run(DatabasePg.withQueryTimeout(hanging, 100))
    expect(Exit.isFailure(exit)).toBe(true)
  })

  test("超时错误信息可定位到 PG 查询", async () => {
    const hanging = Effect.promise(() => new Promise<never>(() => {}))
    const exit = await run(DatabasePg.withQueryTimeout(hanging, 100))
    if (Exit.isFailure(exit)) {
      // Error 不参与 JSON.stringify，必须用 Cause.pretty 取文本
      const text = Cause.pretty(exit.cause)
      expect(text).toContain("PG query timed out")
      expect(text).toContain("100ms")
    } else {
      throw new Error("expected a failure")
    }
  })

  test("正常查询不受影响，不被误杀", async () => {
    const quick = Effect.succeed("rows")
    const exit = await run(DatabasePg.withQueryTimeout(quick, 1000))
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) expect(exit.value).toBe("rows")
  })

  test("耗时接近阈值的查询仍能完成（不提前误杀）", async () => {
    const slow = Effect.promise(
      () => new Promise<string>((resolve) => setTimeout(() => resolve("done"), 60)),
    )
    const exit = await run(DatabasePg.withQueryTimeout(slow, 1000))
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  // 变异测试发现的缺口：withQueryTimeout 本身正确并不代表它接在查询路径上。
  // 这条用例把「配置算出的预算」与「实际生效的等待时长」绑在一起：
  // 预算被换成极大值时，等待时长会远超 bun 的单用例上限而失败。
  test("boundQuery 实际采用配置算出的预算", async () => {
    const options = DatabasePg.makePostgresOptions({
      OPENCODE_PG_STATEMENT_TIMEOUT_MS: "200",
      // grace 也调小，让预算落在百毫秒级，便于断言
      OPENCODE_PG_QUERY_GRACE_MS: "100",
    })
    expect(options.queryTimeoutMs).toBe(300)
    const started = Date.now()
    const hanging = Effect.promise(() => new Promise<never>(() => {}))
    const exit = await run(DatabasePg.boundQuery(hanging, options.queryTimeoutMs))
    const elapsed = Date.now() - started
    expect(Exit.isFailure(exit)).toBe(true)
    expect(elapsed).toBeGreaterThanOrEqual(250)
    expect(elapsed).toBeLessThan(2000)
  })

  test("快速失败的查询保留原始错误", async () => {
    const failing = Effect.fail(new Error("constraint violation"))
    const exit = await run(DatabasePg.withQueryTimeout(failing, 1000))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("constraint violation")
  })
})
