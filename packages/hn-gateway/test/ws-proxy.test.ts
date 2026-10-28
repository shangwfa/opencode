import { describe, expect, it } from "bun:test"

/**
 * ws 透传测试分两层：
 * 1. 销毁/关闭分支：bun 下直接测（确定性）
 * 2. 真实透传 e2e：spawn node 跑 test/ws-e2e.node.mjs
 *    （Bun 的 http server upgrade 后裸写 socket 不可达——运行时限制，已实测；生产用 node 跑，见 README）
 */
describe("socket.io ws 透传", () => {
  it("GATEWAY_WS_PROXY 关闭或非 /socket.io 的 upgrade 被销毁", () => {
    let destroyed = false
    const fakeSocket = {
      destroy: () => (destroyed = true),
      on: () => undefined,
      write: () => undefined,
      pipe: () => undefined,
    }
    let handler: (req: any, socket: any, head: any) => void = () => undefined
    const fakeServer = { on: (_event: string, h: typeof handler) => (handler = h) }
    attachWsProxy(fakeServer as any, () => null)
    handler({ url: "/socket.io/?x=1", headers: {} }, fakeSocket, Buffer.alloc(0))
    expect(destroyed).toBe(true)

    // target 存在但路径不是 /socket.io
    destroyed = false
    attachWsProxy(fakeServer as any, () => "http://127.0.0.1:1")
    handler({ url: "/other-ws", headers: {} }, fakeSocket, Buffer.alloc(0))
    expect(destroyed).toBe(true)
  })

  it("真实透传 e2e（node 子进程）：upgrade → 101 → 数据帧回传", async () => {
    const proc = Bun.spawnSync(["node", "test/ws-e2e.node.mjs"], {
      cwd: import.meta.dir.replace(/\/test$/, ""),
      stdout: "pipe",
      stderr: "pipe",
    })
    const output = new TextDecoder().decode(proc.stdout) + new TextDecoder().decode(proc.stderr)
    expect(output).toContain("[ws-e2e] PASS")
    expect(proc.exitCode).toBe(0)
  })
})

import { attachWsProxy } from "../src/ws-proxy.js"
