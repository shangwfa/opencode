import { describe, expect, it, afterAll } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("日志按日轮转文件", () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-log-"))
  const oldDir = mkdtempSync(join(tmpdir(), "gw-log-old-"))

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(oldDir, { recursive: true, force: true })
  })

  it("写入今日日志文件，内容为 JSON 行", async () => {
    process.env["GATEWAY_LOG_DIR"] = dir
    const { logger } = await import("../src/logger.js")
    logger.info({ span: "t:test", msg: "轮转测试", traceId: "tr-1" })
    const day = new Date().toISOString().slice(0, 10)
    const file = join(dir, `application-${day}.log`)
    const content = readFileSync(file, "utf8")
    expect(content).toContain("轮转测试")
    const parsed = JSON.parse(content.trim().split("\n").at(-1)!)
    expect(parsed).toMatchObject({ level: "info", span: "t:test", service: "hn-gateway" })
  })

  it("清理超过 14 天的旧日志", async () => {
    // 构造 15 天前的日志文件
    mkdirSync(oldDir, { recursive: true })
    const old = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    writeFileSync(join(oldDir, `application-${old}.log`), "old\n")
    const recent = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    writeFileSync(join(oldDir, `application-${recent}.log`), "recent\n")

    process.env["GATEWAY_LOG_DIR"] = oldDir
    // 直接调用清理函数（appendToRotatedFile 的每日一次门槛由模块态控制）
    const { cleanupRotatedLogs } = await import("../src/logger.js")
    cleanupRotatedLogs(oldDir)

    const files = readdirSync(oldDir)
    expect(files).not.toContain(`application-${old}.log`)
    expect(files).toContain(`application-${recent}.log`)
  })
})
