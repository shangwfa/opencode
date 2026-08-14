#!/usr/bin/env bun
import { WebSocket } from "ws"
import { resolve } from "node:path"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { AgentHandler } from "./handler"
import { PathMapper } from "./path"
import { startLocalServer } from "./local-server"
import type { AgentMessage } from "./protocol"

const AGENT_VERSION = "0.0.1"

// 稳定 agentID：持久化在本地，重连/SaaS 重启后 PG 绑定关系仍有效
function loadStableAgentID(): string {
  const dir = resolve(homedir(), ".local/share/opencode")
  const file = resolve(dir, "agent.id")
  try {
    if (existsSync(file)) {
      const id = readFileSync(file, "utf8").trim()
      if (id) return id
    }
    mkdirSync(dir, { recursive: true })
    const id = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    writeFileSync(file, id, "utf8")
    return id
  } catch {
    return `agent-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  }
}

function parseArgs(): { server: string; cwd: string } {
  const args = process.argv.slice(2)
  let server = process.env.OPENCODE_AGENT_SERVER ?? ""
  let cwd = process.cwd()

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--server" || args[i] === "-s") && args[i + 1]) {
      server = args[++i]
    } else if ((args[i] === "--cwd" || args[i] === "-c") && args[i + 1]) {
      cwd = resolve(args[++i])
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`opencode-agent — local execution agent for opencode SaaS

Usage:
  opencode-agent --server ws://host:port/agent-ws [--cwd /path/to/project]

Options:
  -s, --server <url>    SaaS agent ws endpoint (required)
  -c, --cwd <path>      Working directory to map as /workspace (default: cwd)
  -h, --help            Show this help

The agent also starts a local HTTP server on port 17790 for browser detection.
`)
      process.exit(0)
    }
  }

  if (!server) {
    console.error("Error: --server is required (or set OPENCODE_AGENT_SERVER)")
    process.exit(1)
  }

  return { server, cwd }
}

function main() {
  const { server, cwd } = parseArgs()
  const mapper = new PathMapper(cwd)
  const stableID = loadStableAgentID()

  const health = startLocalServer(mapper, AGENT_VERSION)
  console.log(`[agent] connecting to ${server}, workdir=${cwd}`)

  let handler: AgentHandler | null = null
  let ws: WebSocket | null = null
  let reconnectDelay = 1000
  let closed = false

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
  }

  function connect() {
    ws = new WebSocket(server)

    ws.on("open", () => {
      console.log("[agent] connected")
      reconnectDelay = 1000
      handler = new AgentHandler(mapper, (msg) => {
        ws?.send(JSON.stringify(msg))
      })
      const hello: AgentMessage = {
        id: `hello-${Date.now()}`,
        type: "hello",
        workdir: cwd,
        agentVersion: AGENT_VERSION,
        agentID: stableID,
      }
      ws!.send(JSON.stringify(hello))
      // 心跳：25s 一次 ping，SaaS 侧 60s 无任何消息会主动断开
      stopHeartbeat()
      heartbeatTimer = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ id: `ping-${Date.now()}`, type: "ping", ts: Date.now() }))
        }
      }, 25_000)
    })

    ws.on("message", (data) => {
      let msg: AgentMessage
      try {
        msg = JSON.parse(data.toString()) as AgentMessage
      } catch {
        console.error("[agent] invalid message:", data.toString().slice(0, 200))
        return
      }
      if (msg.type === "hello.ack") {
        health.setAgentID(msg.agentID)
        console.log(`[agent] registered as ${msg.agentID}`)
        return
      }
      if (msg.type === "pong") return
      handler?.handle(msg).catch((err) => {
        console.error("[agent] handler error:", err)
      })
    })

    ws.on("close", () => {
      console.log("[agent] disconnected")
      stopHeartbeat()
      handler?.dispose()
      handler = null
      if (closed) return
      setTimeout(() => {
        if (closed) return
        console.log(`[agent] reconnecting in ${reconnectDelay}ms...`)
        connect()
        reconnectDelay = Math.min(reconnectDelay * 2, 30000)
      }, reconnectDelay)
    })

    ws.on("error", (err) => {
      console.error("[agent] ws error:", err.message)
    })
  }

  process.on("SIGINT", () => {
    closed = true
    stopHeartbeat()
    handler?.dispose()
    ws?.close()
    process.exit(0)
  })

  process.on("SIGTERM", () => {
    closed = true
    stopHeartbeat()
    handler?.dispose()
    ws?.close()
    process.exit(0)
  })

  connect()
}

main()
