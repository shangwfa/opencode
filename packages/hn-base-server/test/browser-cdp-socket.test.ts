import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { WebSocketServer } from "ws"
import { WebSocket } from "ws"

/**
 * 回归：WebSocket 在没有任何 error 监听时触发 error，ws 库会 emit 成进程级异常
 * （`Unhandled error. (ErrorEvent ...)`），直接终止整个服务——历史上曾导致登录接口不可用。
 * 这里用真实 WS 服务端模拟「握手后立刻断开 / 拒绝握手」，断言进程不崩、Promise 正常落定。
 */

let server: WebSocketServer
let port = 0
const previous = process.env.OPENCODE_SAAS_URL

beforeAll(async () => {
  server = new WebSocketServer({ port: 0, host: "127.0.0.1" })
  await new Promise<void>((resolve) => server.once("listening", () => resolve()))
  port = (server.address() as { port: number }).port
  process.env.OPENCODE_SAAS_URL = `http://127.0.0.1:${port}`
})

afterAll(() => {
  if (previous === undefined) delete process.env.OPENCODE_SAAS_URL
  else process.env.OPENCODE_SAAS_URL = previous
  server?.close()
})

describe("CDP 连接遇到 socket 错误不会打挂进程", () => {
  test("连接建立后服务端立即断开：连接或读取失败，但无未处理 error", async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (error: unknown) => unhandled.push(error)
    process.on("unhandledRejection", onUnhandled)
    process.on("uncaughtException", onUnhandled)
    server.on("connection", (socket) => {
      // 握手成功后立刻断开，触发客户端 error/close。
      setTimeout(() => socket.terminate(), 10)
    })
    try {
      const { connectCdp } = await import("../src/lib/browser-cdp")
      // 真实发出一次连接；无论成功或失败，都不应产生未处理异常。
      const connected = await connectCdp("ses_test", "PAGE_TEST", AbortSignal.timeout(3000))
        .then((ws) => {
          ws.on("error", () => {})
          return true
        })
        .catch(() => false)
      expect(typeof connected).toBe("boolean")
      // 给断开事件留出触发时间，确认没有 unhandled error。
      await new Promise((resolve) => setTimeout(resolve, 120))
      expect(unhandled).toHaveLength(0)
    } finally {
      process.off("unhandledRejection", onUnhandled)
      process.off("uncaughtException", onUnhandled)
      server.removeAllListeners("connection")
    }
  }, 15_000)

  test("错误事件可以重复触发且不抛进程异常", async () => {
    // 直接验证底层约束：只有挂了常驻 error 监听，重复 emit 才安全。
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    let errors = 0
    ws.on("error", () => {
      errors += 1
    })
    await new Promise<void>((resolve) => {
      ws.once("open", () => resolve())
      ws.once("error", () => resolve())
      setTimeout(resolve, 2000)
    })
    // 连续两次 error 在无监听时会崩溃；有常驻监听则安全。
    expect(() => {
      ws.emit("error", new Error("first"))
      ws.emit("error", new Error("second"))
    }).not.toThrow()
    expect(errors).toBe(2)
    ws.terminate()
  }, 15_000)
})
