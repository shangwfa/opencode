import { Effect } from "effect"
import { WebSocketServer, WebSocket } from "ws"
import type { IncomingMessage } from "node:http"
import { AgentRegistry, type AgentConnection } from "./registry"
import * as Log from "@opencode-ai/core/util/log"
import type { AgentMessage } from "@opencode-ai/agent/src/protocol"

const log = Log.create({ service: "agent-local-ws" })

const AGENT_WS_PATH = "/agent-ws"

export function attachAgentWs(server: import("node:http").Server): void {
  const wss = new WebSocketServer({ noServer: true })

  server.on("upgrade", (req: IncomingMessage, socket: import("node:net").Socket, head: Buffer) => {
    const url = new URL(req.url ?? "", "http://localhost")
    if (url.pathname !== AGENT_WS_PATH) return

    wss.handleUpgrade(req, socket, head, (ws) => {
      handleConnection(ws as WebSocket)
    })
  })
}

function handleConnection(ws: WebSocket): void {
  let connection: AgentConnection | null = null

  ws.on("message", (raw: Buffer) => {
    let msg: AgentMessage
    try {
      msg = JSON.parse(raw.toString("utf8")) as AgentMessage
    } catch {
      log.warn("invalid message from agent")
      return
    }

    if (msg.type === "hello") {
      connection = AgentRegistry.instance.register(msg.workdir, (out) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(out))
      })
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
    if (connection) Effect.runSync(AgentRegistry.instance.unregister(connection.id))
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
    case "exec.result":
      resolvePending(conn, msg.id, msg.res)
      break
    case "interrupted":
      resolvePending(conn, msg.id, { interrupted: true })
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
    pending.onSettle?.()
  }
}

function rejectPending(conn: AgentConnection, id: string, message: string): void {
  const pending = conn.pending.get(id)
  if (pending) {
    conn.pending.delete(id)
    pending.reject(new Error(message))
    pending.onSettle?.()
  }
}
