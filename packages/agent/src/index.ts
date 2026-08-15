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
// 与 SaaS 侧 ws.ts 的 MAX_WS_PAYLOAD 保持一致：拒绝异常超大消息
const MAX_WS_PAYLOAD = 32 * 1024 * 1024
// SaaS 主动关闭码：同 ID 新连接替换旧连接，旧进程应退出而非无限重连互抢
const CLOSE_REPLACED = 4000
// 本地锁：防同机误启第二个同 ID Agent（静默互替、无任何用户可见提示）。
// 锁按 agentID 分文件——不同 ID（如测试注入）互不阻塞
function acquireInstanceLock(dataDir: string, agentID: string): boolean {
  const file = resolve(dataDir, `agent-${agentID}.lock`)
  try {
    const pid = parseInt(readFileSync(file, "utf8").trim(), 10)
    if (Number.isFinite(pid)) {
      // 0 信号探测：进程存活则拒绝启动
      process.kill(pid, 0)
      return false
    }
  } catch (err) {
    // ENOENT（无锁）或 ESRCH（旧进程已死）都视为可获取
    if ((err as NodeJS.ErrnoException).code === "EPERM") return false
  }
  try {
    writeFileSync(file, String(process.pid), "utf8")
  } catch {
    // 锁不可写（只读目录等）：跳过防呆，不阻塞启动
  }
  return true
}

// 稳定 agentID：持久化在本地，重连/SaaS 重启后 PG 绑定关系仍有效
function loadStableAgentID(): string {
  // 测试/多实例注入（e2e 用独立 ID 避免抢占用户 Agent）
  if (process.env.AGENT_ID_OVERRIDE) return process.env.AGENT_ID_OVERRIDE
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
  const dataDir = resolve(homedir(), ".local/share/opencode")
  const stableID = loadStableAgentID()
  if (!acquireInstanceLock(dataDir, stableID)) {
    console.error(`Error: another agent with agentID ${stableID} is already running (see ${resolve(dataDir, `agent-${stableID}.lock`)}).`)
    console.error("If this is stale, remove the lock file or kill the old process.")
    process.exit(1)
  }
  const mapper = new PathMapper(cwd)

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
    ws = new WebSocket(server, { maxPayload: MAX_WS_PAYLOAD })

    ws.on("open", () => {
      console.log("[agent] connected")
      reconnectDelay = 1000
      handler = new AgentHandler(mapper, (msg) => {
        // send 保护：ws 关闭窗口期（dispose 与进程退出之间）残余回调不得崩溃进程
        if (ws?.readyState !== WebSocket.OPEN) return
        try {
          ws.send(JSON.stringify(msg))
        } catch {
          // 已断开：丢弃即可，重连机制会恢复
        }
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

    ws.on("close", (code) => {
      console.log("[agent] disconnected")
      stopHeartbeat()
      handler?.dispose()
      handler = null
      if (closed) return
      if (code === CLOSE_REPLACED) {
        console.log("[agent] replaced by another agent with the same ID, exiting")
        closed = true
        process.exit(0)
      }
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
