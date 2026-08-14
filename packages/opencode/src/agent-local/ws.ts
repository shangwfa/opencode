import { Effect } from "effect"
import { WebSocketServer, WebSocket } from "ws"
import type { IncomingMessage } from "node:http"
import { AgentRegistry, type AgentConnection } from "./registry"
import * as Log from "@opencode-ai/core/util/log"
import type { AgentMessage } from "@opencode-ai/agent/src/protocol"

const log = Log.create({ service: "agent-local-ws" })

const AGENT_WS_PATH = "/agent-ws"
// Agent 25s 一次 ping；60s 无任何消息视为死连接（NAT/LB 静默掐断场景）
const IDLE_KILL_MS = 60_000
// ws 帧上限：覆盖 10MB 输出/base64 文件读取的合法峰值，拒绝异常超大消息
const MAX_WS_PAYLOAD = 32 * 1024 * 1024
// 服务端主动关闭：同 ID 新连接替换旧连接（Agent 收到后退出，防抢占乒乓）
const CLOSE_REPLACED = 4000

export function attachAgentWs(server: import("node:http").Server): () => void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD })

  server.on("upgrade", (req: IncomingMessage, socket: import("node:net").Socket, head: Buffer) => {
    const url = new URL(req.url ?? "", "http://localhost")
    if (url.pathname !== AGENT_WS_PATH) return

    wss.handleUpgrade(req, socket, head, (ws) => {
      handleConnection(ws as WebSocket)
    })
  })

  return () => {
    for (const client of wss.clients) client.terminate()
    wss.close()
  }
}

function handleConnection(ws: WebSocket): void {
  let connection: AgentConnection | null = null
  let lastSeen = Date.now()

  const idleTimer = setInterval(() => {
    if (Date.now() - lastSeen > IDLE_KILL_MS) {
      log.warn("agent idle, terminating connection", { agentID: connection?.id, idleMs: Date.now() - lastSeen })
      ws.terminate()
    }
  }, 15_000)

  ws.on("close", () => clearInterval(idleTimer))

  ws.on("message", (raw: Buffer) => {
    lastSeen = Date.now()
    let msg: AgentMessage
    try {
      msg = JSON.parse(raw.toString("utf8")) as AgentMessage
    } catch {
      log.warn("invalid message from agent")
      return
    }

    if (msg.type === "ping") {
      connection?.send({ id: msg.id, type: "pong", ts: msg.ts })
      return
    }

    if (msg.type === "hello") {
      if (typeof msg.workdir !== "string" || msg.workdir.length === 0 || msg.workdir.length > 4096) {
        log.warn("hello with invalid workdir, closing connection")
        ws.close(1008, "invalid hello")
        return
      }
      // 同连接重复 hello：先注销旧注册再注册新的，否则旧 connection 引用被
      // 覆盖后永远无人清理，registry 留下假在线僵尸条目
      if (connection) {
        log.warn("duplicate hello on same connection, re-registering", { agentID: connection.id })
        Effect.runSync(AgentRegistry.instance.unregister(connection.id, connection))
      }
      connection = AgentRegistry.instance.register(msg.workdir, (out) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(out))
      }, msg.agentID)
      // registry 替换同 ID 旧连接时通过此回调主动关闭旧 ws（防幽灵 Agent）
      connection.close = () => ws.close(CLOSE_REPLACED, "replaced")
      log.info("agent hello received", { agentID: connection.id, workdir: msg.workdir, version: msg.agentVersion })
      connection.send({ id: msg.id, type: "hello.ack", agentID: connection.id })
      return
    }

    if (!connection) {
      log.warn("message before hello, ignoring")
      return
    }

    routeMessage(connection, msg)
  })

  ws.on("close", () => {
    if (connection) Effect.runSync(AgentRegistry.instance.unregister(connection.id, connection))
    log.info("agent ws closed", { agentID: connection?.id })
  })

  ws.on("error", (err) => {
    log.error("agent ws error", { error: err.message, agentID: connection?.id })
  })
}

function routeMessage(conn: AgentConnection, msg: AgentMessage): void {
  switch (msg.type) {
    case "exec.stream":
      conn.pending.get(msg.id)?.onStream?.(msg.stream)
      break
    case "fs.readBytes.stream":
      conn.pending.get(msg.id)?.onStream?.({ chunk: msg.chunk, offset: msg.offset, total: msg.total })
      break
    case "exec.result":
      resolvePending(conn, msg.id, msg.res)
      break
    case "interrupted":
      // 中断也要返回规范 CommandExecution 结构，避免下游把 {interrupted:true}
      // 强转后读到 undefined 的 exitCode/logs
      resolvePending(conn, msg.id, {
        logs: { stdout: [], stderr: [] },
        exitCode: null,
        error: { name: "InterruptedError", value: "Command interrupted", timestamp: Date.now(), traceback: [] },
      })
      break
    case "fs.read.result":
    case "fs.readBytes.result":
    case "fs.stat.result":
    case "pty.create.result":
    case "endpoint.result":
      resolvePending(conn, msg.id, (msg as { res: unknown }).res)
      break
    case "fs.write.result":
      resolvePending(conn, msg.id, undefined)
      break
    case "health.result":
      resolvePending(conn, msg.id, (msg as { res: unknown }).res)
      break
    case "pty.stream":
      conn.pending.get(msg.id)?.onStream?.((msg as { stream: unknown }).stream)
      break
    case "error":
      rejectPending(conn, msg.id, (msg as { message: string }).message)
      break
  }
}

function resolvePending(conn: AgentConnection, id: string, data: unknown): void {
  const pending = conn.pending.get(id)
  if (pending) {
    conn.pending.delete(id)
    pending.resolve(data)
  }
}

function rejectPending(conn: AgentConnection, id: string, message: string): void {
  const pending = conn.pending.get(id)
  if (pending) {
    conn.pending.delete(id)
    pending.reject(new Error(message))
  }
}
