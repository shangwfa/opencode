import { Effect, Duration } from "effect"
import { AgentRegistry } from "./registry"
import type {
  CommandExecution,
  ExecReq,
  FsReadReq,
  FsReadRes,
  FsReadBytesReq,
  FsReadBytesRes,
  FsWriteReq,
  FsStatReq,
  FsStatRes,
} from "@opencode-ai/agent/src/protocol"

const REQUEST_TIMEOUT_MS = 120_000

// sessionID → 活跃 exec 请求 ID 集合（用于会话级中断）
const activeExecs = new Map<string, Set<string>>()

function trackExec(sessionID: string, reqID: string): () => void {
  let set = activeExecs.get(sessionID)
  if (!set) {
    set = new Set()
    activeExecs.set(sessionID, set)
  }
  set.add(reqID)
  return () => {
    set.delete(reqID)
    if (set.size === 0) activeExecs.delete(sessionID)
  }
}

export interface ChannelInterface {
  readonly isAvailable: (sessionID: string) => Effect.Effect<boolean>
  readonly bindAgent: (sessionID: string, agentID: string) => Effect.Effect<void>
  readonly unbindAgent: (sessionID: string) => Effect.Effect<void>
  readonly listAgents: () => Array<{ agentID: string; workdir: string; boundSessions: string[] }>
  readonly exec: (
    sessionID: string,
    req: ExecReq,
    onStream?: (data: { event: string; text: string }) => void,
    signal?: AbortSignal,
  ) => Effect.Effect<CommandExecution, Error>
  readonly interruptSession: (sessionID: string) => Effect.Effect<void>
  readonly fsRead: (sessionID: string, req: FsReadReq) => Effect.Effect<FsReadRes, Error>
  readonly fsReadBytes: (sessionID: string, req: FsReadBytesReq) => Effect.Effect<FsReadBytesRes, Error>
  readonly fsReadBytesStream: (sessionID: string, req: FsReadBytesReq) => Promise<Uint8Array>
  readonly fsWrite: (sessionID: string, req: FsWriteReq) => Effect.Effect<void, Error>
  readonly fsStat: (sessionID: string, req: FsStatReq) => Effect.Effect<FsStatRes, Error>
  readonly getEndpoint: (sessionID: string, port: number) => Effect.Effect<string, Error>
}

function request<T>(
  sessionID: string,
  type: string,
  payload: Record<string, unknown>,
  onStream?: (data: unknown) => void,
  signal?: AbortSignal,
): Effect.Effect<T, Error> {
  return Effect.gen(function* () {
    const conn = yield* AgentRegistry.instance.getForSession(sessionID)
    if (!conn) return yield* Effect.fail(new Error(`No local agent for session ${sessionID}`))

    const id = `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    return yield* Effect.callback<T, Error>((resume) => {
      const untrack = type === "exec" ? trackExec(sessionID, id) : null
      // Effect 的 resume 只允许调用一次；timeout/abort 先结束后，迟到的
      // agent 响应不能再 resolve/reject，否则抛 defect 并拖垮 ws 连接。
      let settled = false
      const settle = (effect: Effect.Effect<T, Error>) => {
        if (settled) return
        settled = true
        resume(effect)
      }
      const entry = {
        resolve: (data: unknown) => settle(Effect.succeed(data as T)),
        reject: (err: Error) => settle(Effect.fail(err)),
        onStream,
        onSettle: untrack ?? undefined,
      }
      conn.pending.set(id, entry)

      // 请求体统一携带 sessionID（注入 req 内层）：Agent 端按会话隔离工作区
      const body = payload.req && typeof payload.req === "object" ? { ...payload, req: { ...payload.req, sessionID } } : payload
      conn.send({ id, type, ...body })

      const timer = setTimeout(() => {
        conn.pending.delete(id)
        untrack?.()
        entry.reject(new Error(`Agent request ${type} timed out after ${REQUEST_TIMEOUT_MS}ms`))
      }, REQUEST_TIMEOUT_MS)

      const onAbort = () => {
        clearTimeout(timer)
        conn.pending.delete(id)
        untrack?.()
        conn.send({ id, type: "interrupt" })
        entry.reject(new Error("Aborted"))
      }

      if (signal) {
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener("abort", onAbort, { once: true })
      }
    })
  }).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(REQUEST_TIMEOUT_MS),
      orElse: () => Effect.fail(new Error(`Agent request ${type} timed out`)),
    }),
  )
}

export const instance: ChannelInterface = {
  isAvailable: (sessionID) =>
    Effect.gen(function* () {
      const conn = yield* AgentRegistry.instance.getForSession(sessionID)
      return conn !== null
    }),

  bindAgent: (sessionID, agentID) => AgentRegistry.instance.bindSession(sessionID, agentID),

  unbindAgent: (sessionID) => AgentRegistry.instance.unbindSession(sessionID),

  listAgents: () => AgentRegistry.instance.list(),

  exec: (sessionID, req, onStream, signal) =>
    request<CommandExecution>(sessionID, "exec", { req }, (data) => {
      const stream = data as { event: string; text?: string }
      if (onStream && stream.text) onStream({ event: stream.event, text: stream.text })
    }, signal),

  interruptSession: (sessionID) =>
    Effect.gen(function* () {
      const conn = yield* AgentRegistry.instance.getForSession(sessionID)
      if (!conn) return
      const reqIDs = activeExecs.get(sessionID)
      if (!reqIDs) return
      for (const reqID of reqIDs) {
        conn.send({ id: reqID, type: "interrupt" })
      }
    }),

  fsRead: (sessionID, req) => request<FsReadRes>(sessionID, "fs.read", { req }),
  fsReadBytes: (sessionID, req) => request<FsReadBytesRes>(sessionID, "fs.readBytes", { req }),

  // 分片流式读取：Agent 逐块回传 fs.readBytes.stream，result 信号结束
  fsReadBytesStream: (sessionID, req) =>
    new Promise<Uint8Array>((resolve, reject) => {
      const chunks: Buffer[] = []
      request<FsReadBytesRes>(sessionID, "fs.readStream", { req }, (data) => {
        const ev = data as { chunk?: string }
        if (ev.chunk) chunks.push(Buffer.from(ev.chunk, "base64"))
      }).pipe(Effect.runPromiseExit).then((exit) => {
        if (exit._tag === "Failure") reject(new Error("fs.readStream failed"))
        else resolve(Buffer.concat(chunks))
      })
    }),

  fsWrite: (sessionID, req) => request<void>(sessionID, "fs.write", { req }),
  fsStat: (sessionID, req) => request<FsStatRes>(sessionID, "fs.stat", { req }),

  getEndpoint: (sessionID, port) =>
    Effect.gen(function* () {
      const res = yield* request<{ url: string }>(sessionID, "endpoint", { req: { port } })
      return res.url
    }),
}

export * as LocalAgentChannel from "./channel"
