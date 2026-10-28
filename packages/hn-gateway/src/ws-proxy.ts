/**
 * /socket.io WebSocket 透传（原 main.ts http-proxy ws 语义：upgrade 请求转发到
 * chatbot 后端，changeOrigin 改写 Host）。GATEWAY_WS_PROXY=off 关闭（等价原 DISABLE_PROXY）。
 * 非 /socket.io 的 upgrade 一律销毁。
 *
 * 实现说明：出站腿用原生 net socket 手写 upgrade 请求——Bun 的 http 客户端不触发
 * 'upgrade' 事件（已实测），原生 TCP 在 Bun/node 下行为一致。
 */
import * as net from "node:net"
import type { Server } from "node:http"
import { logger } from "./logger.js"

export function attachWsProxy(server: Server, getTarget: () => string | null): void {
  server.on("upgrade", (req, socket, head) => {
    const target = getTarget()
    if (!target || !req.url?.startsWith("/socket.io")) {
      socket.destroy()
      return
    }

    let upstream: URL
    try {
      upstream = new URL(target)
    } catch {
      socket.destroy()
      return
    }
    const port = Number(upstream.port) || (upstream.protocol === "https:" ? 443 : 80)

    const upSocket = net.connect(port, upstream.hostname)
    upSocket.setTimeout(10_000, () => {
      logger.error({ span: "ws:proxy:error", msg: "upstream 连接超时" })
      upSocket.destroy()
      socket.destroy()
    })
    upSocket.on("error", (error: Error) => {
      logger.error({ span: "ws:proxy:error", msg: "ws 透传失败", error: String(error) })
      socket.destroy()
    })

    upSocket.on("connect", () => {
      // changeOrigin：Host 改写为目标；透传 ws 握手必需头与身份类头
      const lines = [`${req.method} ${req.url} HTTP/1.1`, `Host: ${upstream.host}`, `Connection: Upgrade`, `Upgrade: websocket`]
      const passThrough: [string, string | undefined][] = [
        ["sec-websocket-key", req.headers["sec-websocket-key"] as string | undefined],
        ["sec-websocket-version", req.headers["sec-websocket-version"] as string | undefined],
        ["sec-websocket-protocol", req.headers["sec-websocket-protocol"] as string | undefined],
        ["sec-websocket-extensions", req.headers["sec-websocket-extensions"] as string | undefined],
        ["origin", req.headers["origin"]],
        ["cookie", req.headers["cookie"]],
        ["authorization", req.headers["authorization"]],
        ["x-forwarded-for", req.socket?.remoteAddress ?? undefined],
      ]
      for (const [name, value] of passThrough) {
        if (value) lines.push(`${name}: ${value}`)
      }
      upSocket.write(lines.join("\r\n") + "\r\n\r\n")
      if (head.length) upSocket.write(head)
      logger.debug({ span: "ws:proxied", msg: `ws 握手已转发: ${req.url}` })
    })

    // 解析 upstream 响应：透传状态行+响应头，101 后双向 pipe
    let buffered = Buffer.alloc(0)
    let relayed = false
    upSocket.on("data", (chunk: Buffer) => {
      if (relayed) {
        socket.write(chunk)
        return
      }
      buffered = Buffer.concat([buffered, chunk])
      const idx = buffered.indexOf("\r\n\r\n")
      if (idx === -1) return
      const headerText = buffered.subarray(0, idx).toString("utf8")
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(headerText)?.[1] ?? 0)
      logger.debug({ span: "ws:upstream-status", msg: `upstream 状态: ${status}` })
      socket.write(buffered)
      buffered = Buffer.alloc(0)
      relayed = true
      upSocket.setTimeout(0)
      if (status === 101) {
        upSocket.pipe(socket)
        socket.pipe(upSocket)
      } else {
        // upstream 拒绝升级：响应已透传，收尾
        socket.end()
        upSocket.destroy()
      }
    })

    socket.on("error", () => upSocket.destroy())
    socket.on("close", () => upSocket.destroy())
    upSocket.on("close", () => socket.destroy())
  })
}
