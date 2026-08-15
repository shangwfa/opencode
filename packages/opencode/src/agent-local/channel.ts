import { Effect } from "effect"
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
  SessionCleanupReq,
} from "@opencode-ai/agent/src/protocol"

// 请求超时上限；exec 等携带自身 deadline 的请求按 deadline 推导，
// 使 Agent 侧超时先于 SaaS 放弃等待（合法长命令不会被提前掐断）
const REQUEST_TIMEOUT_MS = 120_000
// agent 超时回包在网络上的宽限
const REQUEST_GRACE_MS = 5_000

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
  readonly cleanupSession: (sessionID: string) => Effect.Effect<void, Error>
  readonly getEndpoint: (sessionID: string, port: number) => Effect.Effect<string, Error>
}

function request<T>(
  sessionID: string,
  type: string,
  payload: Record<string, unknown>,
  onStream?: (data: unknown) => void,
  signal?: AbortSignal,
  timeoutMs?: number,
): Effect.Effect<T, Error> {
  return Effect.gen(function* () {
    const conn = yield* AgentRegistry.instance.getForSession(sessionID)
    if (!conn) return yield* Effect.fail(new Error(`No local agent for session ${sessionID}`))

    const id = `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    // 带 deadline 的请求：SaaS 等待窗口 = agent deadline + 网络宽限，
    // 保证 Agent 侧先超时并回 TimeoutError，而不是 SaaS 先放弃
    const waitMs = timeoutMs ? Math.min(timeoutMs + REQUEST_GRACE_MS, REQUEST_TIMEOUT_MS + REQUEST_GRACE_MS) : REQUEST_TIMEOUT_MS

    return yield* Effect.callback<T, Error>((resume) => {
      const untrack = type === "exec" ? trackExec(sessionID, id) : null
      // Effect 的 resume 只允许调用一次；所有结算路径共用幂等 settle：
      // 统一清理 timer、abort listener、pending 表与 exec 跟踪
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const cleanup = () => {
        if (timer) clearTimeout(timer)
        timer = undefined
        if (onAbort) signal?.removeEventListener("abort", onAbort)
        conn.pending.delete(id)
        untrack?.()
      }
      const settle = (effect: Effect.Effect<T, Error>) => {
        if (settled) return
        settled = true
        cleanup()
        resume(effect)
      }
      let onAbort: (() => void) | undefined
      const entry = {
        resolve: (data: unknown) => settle(Effect.succeed(data as T)),
        reject: (err: Error) => settle(Effect.fail(err)),
        onStream,
      }
      conn.pending.set(id, entry)

      // 请求体统一携带 sessionID（注入 req 内层）：Agent 端按会话隔离工作区
      const body = payload.req && typeof payload.req === "object" ? { ...payload, req: { ...payload.req, sessionID } } : payload
      conn.send({ id, type, ...body })

      // 超时必须通知 Agent 取消：只丢弃 pending 会让命令在用户机器上继续
      // 执行成幽灵副作用（SaaS 已放弃等待但本地仍在跑）
      timer = setTimeout(() => {
        conn.send({ id, type: "interrupt" })
        settle(Effect.fail(new Error(`Agent request ${type} timed out after ${waitMs}ms`)))
      }, waitMs)

      onAbort = () => {
        conn.send({ id, type: "interrupt" })
        settle(Effect.fail(new Error("Aborted")))
      }

      if (signal) {
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener("abort", onAbort, { once: true })
      }

      // fiber 被 timeout/interrupt 打断时同样走 settle 清理（Effect.callback
      // 返回的 Effect 作为中断 finalizer 运行）
      return Effect.sync(() => settle(Effect.fail(new Error("Cancelled"))))
    })
  })
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
    }, signal, req.timeoutMs),

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

  // 会话删除后的工作区回收（session.remove → destroy → 此处）
  cleanupSession: (sessionID) =>
    request<void>(sessionID, "session.cleanup", { req: { sessionID } satisfies SessionCleanupReq }),

  getEndpoint: (sessionID, port) =>
    Effect.gen(function* () {
      const res = yield* request<{ url: string }>(sessionID, "endpoint", { req: { port } })
      return res.url
    }),
}

export * as LocalAgentChannel from "./channel"
