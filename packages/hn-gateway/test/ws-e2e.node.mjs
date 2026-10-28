/**
 * ws 透传 e2e（在 node 运行时下执行；Bun 的 http server upgrade 后裸写不可达，已实测）。
 * 由 bun test 通过 spawnSync 调起，退出码 0 = 通过。
 * 前置：dist/ws-proxy.mjs 已由 esbuild 构建（见 package.json test script）。
 */
import * as http from "node:http"
import * as net from "node:net"
import { attachWsProxy } from "../dist/ws-proxy.mjs"

// 假 ws upstream：收到 upgrade 回 101 + 文本帧 "hi"（0x81 len，server→client 帧不掩码）
const upstream = net.createServer((socket) => {
  socket.on("data", (data) => {
    if (data.toString().includes("Upgrade: websocket")) {
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
      socket.write(Buffer.from([0x81, 0x02, 0x68, 0x69]))
    }
  })
})

function fail(message) {
  console.error(`[ws-e2e] FAIL: ${message}`)
  process.exit(1)
}

upstream.listen(0, "127.0.0.1", () => {
  const upstreamPort = upstream.address().port
  const gateway = http.createServer(() => undefined)
  attachWsProxy(gateway, () => `http://127.0.0.1:${upstreamPort}`)
  gateway.listen(0, "127.0.0.1", () => {
    const gatewayPort = gateway.address().port
    const client = net.connect(gatewayPort, "127.0.0.1")
    let received = ""
    const timer = setTimeout(() => fail(`超时，已收到: ${JSON.stringify(received.slice(0, 120))}`), 5000)
    client.on("data", (chunk) => {
      received += chunk.toString("utf8")
      if (received.includes("hi")) {
        clearTimeout(timer)
        const ok = received.includes("101 Switching Protocols") && received.includes("hi")
        console.log(`[ws-e2e] ${ok ? "PASS" : "FAIL"}: 收到 ${JSON.stringify(received.slice(0, 80))}`)
        client.destroy()
        gateway.close(() => upstream.close(() => process.exit(ok ? 0 : 1)))
      }
    })
    client.on("error", (error) => {
      clearTimeout(timer)
      fail(String(error))
    })
    client.on("connect", () => {
      client.write(
        "GET /socket.io/?EIO=4&transport=websocket HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
      )
    })
  })
})
