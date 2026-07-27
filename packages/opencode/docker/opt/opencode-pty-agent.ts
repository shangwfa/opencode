import { spawn } from "bun-pty"
import { createHmac, timingSafeEqual } from "node:crypto"

const port = Number(process.env.OPENCODE_PTY_AGENT_PORT ?? "4097")
const bufferLimit = 2 * 1024 * 1024
const replayChunk = 64 * 1024
const exitedLimit = 25
const eventLimit = 512
const token = process.env.OPENCODE_PTY_AGENT_TOKEN ?? ""
const instanceID = crypto.randomUUID()
const sessions = new Map<string, Session>()
const exitOrder: string[] = []
const eventStreams = new Set<ReadableStreamDefaultController<string>>()
const eventLog: Array<{ id: number; type: string; data: object }> = []
let eventCursor = 0
const attachments = new WeakMap<Bun.ServerWebSocket<SocketData>, Attachment>()

type Info = {
  id: string
  title: string
  command: string
  args: string[]
  cwd: string
  status: "running" | "exited"
  pid: number
  exitCode?: number
}

type Subscriber = {
  socket: Bun.ServerWebSocket<SocketData>
  active: boolean
  pending: string[]
}

type Session = {
  owner: string
  info: Info
  process: ReturnType<typeof spawn>
  buffer: string
  bufferCursor: number
  cursor: number
  subscribers: Set<Subscriber>
}

type SocketData = {
  id: string
  cursor?: number
}

type Attachment = {
  session: Session
  subscriber: Subscriber
}

function emit(type: string, data: object) {
  const event = { id: ++eventCursor, type, data }
  eventLog.push(event)
  if (eventLog.length > eventLimit) eventLog.shift()
  const message = frame(event)
  for (const stream of eventStreams) {
    try {
      if ((stream.desiredSize ?? 1) <= 0) {
        stream.error(new Error("PTY event subscriber exceeded its buffer"))
        eventStreams.delete(stream)
        continue
      }
      stream.enqueue(message)
    } catch {
      eventStreams.delete(stream)
    }
  }
}

function frame(event: { id: number; type: string; data: object }) {
  return `id: ${event.id}\ndata: ${JSON.stringify({ type: event.type, data: event.data })}\n\n`
}

function json(value: unknown, status = 200) {
  return Response.json(value, { status })
}

function websocketToken(url: URL) {
  const match = /^\/pty\/(pty_[^/]+)\/connect$/.exec(url.pathname)
  const owner = url.searchParams.get("sessionID")
  const expires = Number(url.searchParams.get("expires"))
  const provided = url.searchParams.get("token")
  if (!match || !owner || !provided || !Number.isSafeInteger(expires) || expires < Date.now() || expires > Date.now() + 60_000)
    return false
  const expected = createHmac("sha256", token).update(`${owner}:${match[1]}:${expires}`).digest("hex")
  return provided.length === expected.length && timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
}

async function body(request: Request) {
  try {
    return (await request.json()) as Record<string, unknown>
  } catch {
    return {}
  }
}

function shell() {
  const configured = process.env.SHELL
  if (configured && Bun.file(configured).size) return configured
  return Bun.which("bash") ?? "/bin/sh"
}

function login(command: string) {
  const name = command.split("/").at(-1)?.toLowerCase()
  return name === "bash" || name === "zsh" || name === "fish"
}

function create(owner: string, input: Record<string, unknown>) {
  const id = `pty_${crypto.randomUUID().replaceAll("-", "")}`
  const command = typeof input.command === "string" ? input.command : shell()
  const args = Array.isArray(input.args) ? input.args.filter((item): item is string => typeof item === "string") : []
  if (!input.command && login(command)) args.push("-l")
  const cwd = typeof input.cwd === "string" && input.cwd.startsWith("/") ? input.cwd : "/workspace"
  const customEnv =
    input.env && typeof input.env === "object" && !Array.isArray(input.env)
      ? Object.fromEntries(Object.entries(input.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : {}
  const safeEnv = Object.fromEntries(
    Object.entries(globalThis.process.env).filter(([key]) => key !== "OPENCODE_PTY_AGENT_TOKEN"),
  )
  const process = spawn(command, args, {
    name: "xterm-256color",
    cwd,
    env: {
      ...safeEnv,
      ...customEnv,
      TERM: "xterm-256color",
      OPENCODE_TERMINAL: "1",
    },
  })
  const info: Info = {
    id,
    title: typeof input.title === "string" ? input.title : `Terminal ${id.slice(-4)}`,
    command,
    args,
    cwd,
    status: "running",
    pid: process.pid,
  }
  const session: Session = {
    owner,
    info,
    process,
    buffer: "",
    bufferCursor: 0,
    cursor: 0,
    subscribers: new Set(),
  }
  sessions.set(id, session)
  process.onData((chunk) => {
    session.cursor += chunk.length
    for (const subscriber of session.subscribers) {
      if (!subscriber.active) {
        subscriber.pending.push(chunk)
        continue
      }
      try {
        subscriber.socket.send(chunk)
      } catch {
        session.subscribers.delete(subscriber)
      }
    }
    session.buffer += chunk
    if (session.buffer.length <= bufferLimit) return
    const excess = session.buffer.length - bufferLimit
    session.buffer = session.buffer.slice(excess)
    session.bufferCursor += excess
  })
  process.onExit(({ exitCode }) => {
    if (session.info.status === "exited") return
    session.info.status = "exited"
    session.info.exitCode = exitCode
    for (const subscriber of session.subscribers) subscriber.socket.close(1000)
    session.subscribers.clear()
    emit("pty.exited", { id, exitCode })
    exitOrder.push(id)
    while (exitOrder.length > exitedLimit) {
      const oldest = exitOrder.shift()
      if (oldest) remove(oldest)
    }
  })
  emit("pty.created", { info })
  return info
}

function remove(id: string) {
  const session = sessions.get(id)
  if (!session) return false
  sessions.delete(id)
  const exited = exitOrder.indexOf(id)
  if (exited !== -1) exitOrder.splice(exited, 1)
  if (session.info.status === "running") session.process.kill()
  for (const subscriber of session.subscribers) subscriber.socket.close(1000)
  session.subscribers.clear()
  emit("pty.deleted", { id })
  return true
}

const server = Bun.serve<SocketData>({
  hostname: "0.0.0.0",
  port,
  async fetch(request, server) {
    const url = new URL(request.url)
    const authorized = token && request.headers.get("authorization") === `Bearer ${token}`
    const websocketAuthorized = token && websocketToken(url)
    if (!authorized && !websocketAuthorized) return json({ error: "Unauthorized" }, 401)
    if (url.pathname === "/health" && request.method === "GET")
      return json({ status: "ready", protocolVersion: 1, instanceID })

    if (url.pathname === "/pty/events" && request.method === "GET") {
      const cursor = Number(request.headers.get("last-event-id") ?? url.searchParams.get("cursor") ?? "0")
      const oldest = eventLog[0]?.id
      if (Number.isSafeInteger(cursor) && oldest !== undefined && cursor < oldest - 1)
        return json({ error: "Event cursor expired", instanceID, oldest, latest: eventCursor }, 409)
      let active: ReadableStreamDefaultController<string> | undefined
      const stream = new ReadableStream<string>({
        start(controller) {
          active = controller
          for (const event of eventLog) {
            if (!Number.isSafeInteger(cursor) || event.id > cursor) controller.enqueue(frame(event))
          }
          eventStreams.add(controller)
        },
        cancel() {
          if (active) eventStreams.delete(active)
        },
      })
      return new Response(stream.pipeThrough(new TextEncoderStream()), {
        headers: {
          "cache-control": "no-cache",
          "content-type": "text/event-stream",
          "x-opencode-pty-agent-instance": instanceID,
        },
      })
    }

    const owner = url.searchParams.get("sessionID")
    if (!owner) return json({ error: "sessionID is required" }, 400)
    if (url.pathname === "/pty" && request.method === "GET")
      return json(
        Array.from(sessions.values())
          .filter((session) => owner === "*" || session.owner === owner)
          .map((session) => session.info),
      )
    if (owner === "*") return json({ error: "Wildcard sessionID is read-only" }, 400)
    if (url.pathname === "/pty" && request.method === "POST") {
      try {
        return json(create(owner, await body(request)), 201)
      } catch (cause) {
        console.error("[pty-agent] create failed", cause)
        return json({ error: cause instanceof Error ? cause.message : "Failed to create PTY" }, 400)
      }
    }

    const match = /^\/pty\/(pty_[^/]+)(?:\/(connect))?$/.exec(url.pathname)
    if (!match) return json({ error: "Not found" }, 404)
    const id = match[1]
    const session = sessions.get(id)
    if (!session || session.owner !== owner) return json({ error: "PTY not found" }, 404)

    if (match[2] === "connect" && request.method === "GET") {
      if (session.info.status === "exited") return json({ error: "PTY exited" }, 409)
      const raw = url.searchParams.get("cursor")
      const cursor = raw === null ? undefined : Number(raw)
      if (!server.upgrade(request, { data: { id, cursor: Number.isSafeInteger(cursor) ? cursor : undefined } }))
        return json({ error: "WebSocket upgrade failed" }, 400)
      return
    }

    if (request.method === "GET") return json(session.info)
    if (request.method === "PUT") {
      const input = await body(request)
      if (typeof input.title === "string") session.info.title = input.title
      const size =
        input.size && typeof input.size === "object" && !Array.isArray(input.size)
          ? (input.size as Record<string, unknown>)
          : undefined
      if (
        session.info.status === "running" &&
        size &&
        typeof size.cols === "number" &&
        typeof size.rows === "number"
      )
        session.process.resize(size.cols, size.rows)
      emit("pty.updated", { info: session.info })
      return json(session.info)
    }
    if (request.method === "DELETE") {
      remove(id)
      return new Response(null, { status: 204 })
    }
    return json({ error: "Method not allowed" }, 405)
  },
  websocket: {
    backpressureLimit: 1024 * 1024,
    closeOnBackpressureLimit: true,
    open(socket) {
      const session = sessions.get(socket.data.id)
      if (!session || session.info.status !== "running") {
        socket.close(4404)
        return
      }
      const subscriber = { socket, active: false, pending: [] }
      session.subscribers.add(subscriber)
      attachments.set(socket, { session, subscriber })
      const end = session.cursor
      const from = socket.data.cursor === -1 ? end : Math.max(0, socket.data.cursor ?? 0)
      const offset = Math.max(0, from - session.bufferCursor)
      const replay = offset < session.buffer.length ? session.buffer.slice(offset) : ""
      for (let index = 0; index < replay.length; index += replayChunk) socket.send(replay.slice(index, index + replayChunk))
      const meta = new TextEncoder().encode(JSON.stringify({ cursor: end }))
      const frame = new Uint8Array(meta.length + 1)
      frame[0] = 0
      frame.set(meta, 1)
      socket.send(frame)
      subscriber.active = true
      for (const chunk of subscriber.pending) socket.send(chunk)
      subscriber.pending.length = 0
    },
    message(socket, message) {
      const attachment = attachments.get(socket)
      if (!attachment || attachment.session.info.status !== "running") return
      try {
        attachment.session.process.write(
          typeof message === "string" ? message : new TextDecoder("utf-8", { fatal: true }).decode(message),
        )
      } catch {}
    },
    close(socket) {
      const attachment = attachments.get(socket)
      if (!attachment) return
      attachment.session.subscribers.delete(attachment.subscriber)
      attachments.delete(socket)
    },
  },
})

const shutdown = () => {
  for (const id of sessions.keys()) remove(id)
  server.stop(true)
  process.exit(0)
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
console.log(`[pty-agent] listening on ${server.url}`)
