import { spawn, type ChildProcess } from "node:child_process"
import * as fs from "node:fs/promises"
import { rmSync } from "node:fs"
import * as path from "node:path"
import { PathMapper, SessionMapper } from "./path"
import type { PtyManager } from "./pty-manager"
import type {
  AgentMessage,
  CommandExecution,
  ExecReq,
  FsReadReq,
  FsReadBytesReq,
  FsWriteReq,
  FsStatReq,
  PtyCreateReq,
  SessionCleanupReq,
} from "./protocol"

type PendingExec = {
  proc: ChildProcess
  stdout: { text: string }[]
  stderr: { text: string }[]
  bytes: number
  truncated: boolean
  timer?: ReturnType<typeof setTimeout>
  kill: (sig?: NodeJS.Signals) => void
}

// exec 硬性保护：输出环形上限与默认超时，防止 yes 类命令拖垮 agent。
// 上限在接收 chunk 时实时生效（超限即终止进程、停止缓存与发送）。
const MAX_OUTPUT_CHARS = 10 * 1024 * 1024
const DEFAULT_EXEC_TIMEOUT_MS = 10 * 60 * 1000
// interrupt 先 SIGINT 进程组；忽略信号的进程（trap '' INT）在宽限期后升级 SIGKILL
const INTERRUPT_GRACE_MS = 5_000

export class AgentHandler {
  private ptyManager: PtyManager | null = null
  private pendingExecs = new Map<string, PendingExec>()
  private sessionMappers = new Map<string, SessionMapper>()

  constructor(
    private mapper: PathMapper,
    private send: (msg: AgentMessage) => void,
  ) {}

  // 会话隔离：每个 sessionID 独立工作区（首次使用时创建目录）
  private session(sessionID: string): SessionMapper {
    let m = this.sessionMappers.get(sessionID)
    if (!m) {
      m = this.mapper.forSession(sessionID)
      this.sessionMappers.set(sessionID, m)
    }
    m.ensure()
    return m
  }

  async handle(msg: AgentMessage): Promise<void> {
    switch (msg.type) {
      case "exec":
        return this.handleExec(msg.id, msg.req)
      case "interrupt":
        return this.handleInterrupt(msg.id)
      case "fs.read":
        return this.handleFsRead(msg.id, msg.req)
      case "fs.readBytes":
        return this.handleFsReadBytes(msg.id, msg.req)
      case "fs.readStream":
        return this.handleFsReadBytesStream(msg.id, msg.req)
      case "fs.write":
        return this.handleFsWrite(msg.id, msg.req)
      case "fs.stat":
        return this.handleFsStat(msg.id, msg.req)
      case "pty.create":
        return this.handlePtyCreate(msg.id, msg.req)
      case "pty.input":
        return this.handlePtyInput(msg.ptyId, msg.data)
      case "pty.resize":
        return this.handlePtyResize(msg.ptyId, msg.cols, msg.rows)
      case "pty.kill":
        return this.handlePtyKill(msg.ptyId)
      case "endpoint":
        return this.handleEndpoint(msg.id, msg.req.port)
      case "health":
        return this.send({ id: msg.id, type: "health.result", res: { ok: true } })
      case "session.cleanup":
        return this.handleSessionCleanup(msg.id, msg.req)
    }
  }

  // 会话删除后的工作区回收：只允许删除 {root}/sessions/{sessionID} 本身，
  // 且目录必须真实位于 sessions 根之下（复用 PathMapper 的 sessionID 白名单）
  private handleSessionCleanup(id: string, req: SessionCleanupReq): void {
    try {
      const ses = this.mapper.forSession(req.sessionID)
      rmSync(ses.dir, { recursive: true, force: true })
      this.sessionMappers.delete(req.sessionID)
      console.log(`[cleanup] session ${req.sessionID.slice(-8)} workspace removed`)
      this.send({ id, type: "session.cleanup.result" })
    } catch (err) {
      this.send({ id, type: "error", message: `session.cleanup failed: ${err instanceof Error ? err.message : String(err)}` })
    }
  }

  private handleExec(id: string, req: ExecReq): void {
    // 重复请求 ID 直接拒绝：静默覆盖会让第二个请求的结果被幂等守卫丢弃、
    // 且调用方收到第一个命令的串线输出
    if (this.pendingExecs.has(id)) {
      this.send({ id, type: "error", message: `duplicate exec request id: ${id}` })
      return
    }
    // 会话目录创建/校验失败（只读 cwd、被删根等）必须显式回错：
    // 吞掉会让请求挂死到 SaaS 侧 120s 超时
    let mapper: SessionMapper
    let cwd: string
    try {
      mapper = this.session(req.sessionID)
      cwd = mapper.toReal(req.cwd)
    } catch (err) {
      this.send({ id, type: "error", message: `session workspace unavailable: ${err instanceof Error ? err.message : String(err)}` })
      return
    }
    const started = Date.now()
    // detached：独立进程组，超时/中断/收尾时 kill(-pid) 能清掉 sh 的子进程。
    // stdin 用 ignore 而非 pipe：Bun 在 macOS 的 pipe 是 unix socketpair 且
    // 不发 EOF，rg 等工具探测到"可读 stdin"会进入 stdin 模式并永久挂死
    // （rg pattern | head 场景实测）；/dev/null 使其回退到目录搜索模式
    const proc = spawn("sh", ["-c", mapper.rewriteCommand(req.command)], {
      cwd,
      env: { ...process.env, ...req.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    })

    const pending: PendingExec = {
      proc,
      stdout: [],
      stderr: [],
      bytes: 0,
      truncated: false,
      kill: (sig: NodeJS.Signals = "SIGKILL") => {
        try {
          if (proc.pid != null) process.kill(-proc.pid, sig)
        } catch {
          proc.kill(sig)
        }
      },
    }
    this.pendingExecs.set(id, pending)

    const onChunk = (arr: { text: string }[], event: "stdout" | "stderr") => (chunk: Buffer) => {
      const text = chunk.toString("utf8")
      pending.bytes += text.length
      // 运行期实时上限：超限后立即终止进程，不再缓存、不再发送，
      // 防止内存线性增长与 exec.stream 风暴拖垮 SaaS
      if (pending.bytes > MAX_OUTPUT_CHARS) {
        if (!pending.truncated) {
          pending.truncated = true
          pending.kill("SIGKILL")
        }
        return
      }
      arr.push({ text })
      this.send({ id, type: "exec.stream", stream: { event, text } })
    }
    proc.stdout?.on("data", onChunk(pending.stdout, "stdout"))
    proc.stderr?.on("data", onChunk(pending.stderr, "stderr"))

    // 幂等守卫：timeout/interrupt 先结束后，迟到的 exit 事件不得再发第二条 result
    const finish = (exitCode: number | null, error?: CommandExecution["error"]) => {
      if (!this.pendingExecs.has(id)) return
      if (pending.timer) clearTimeout(pending.timer)
      this.pendingExecs.delete(id)
      // 正常退出后清理进程组：后台子进程（(sleep 600 &) 类）不得成为孤儿
      if (exitCode != null) pending.kill("SIGKILL")
      const durationMs = Date.now() - started
      const errOut: CommandExecution["error"] | undefined =
        error ?? (pending.truncated
          ? { name: "TruncatedError", value: "output truncated", timestamp: Date.now(), traceback: [] }
          : undefined)
      console.log(
        `[exec] ${exitCode ?? "err"} ${durationMs}ms ses=${req.sessionID.slice(-8)} cwd=${req.cwd} cmd=${JSON.stringify(req.command.slice(0, 120))}` +
          (errOut ? ` error=${errOut.name}: ${errOut.value.slice(0, 80)}` : ""),
      )
      this.send({
        id,
        type: "exec.result",
        res: { logs: { stdout: pending.stdout, stderr: pending.stderr }, exitCode, error: errOut },
      })
    }

    proc.on("error", (err) => {
      finish(null, {
        name: err.name,
        value: err.message,
        timestamp: Date.now(),
        traceback: [],
      })
    })

    // exit 即结算（后台子进程继承 stdout 会让 close 永不触发）；
    // finish 内会清理进程组，孤儿释放的输出流随之关闭
    proc.on("exit", (code) => {
      finish(code)
    })

    const timeoutMs = req.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS
    pending.timer = setTimeout(() => {
      pending.kill("SIGKILL")
      finish(null, {
        name: "TimeoutError",
        value: `Command timed out after ${timeoutMs}ms`,
        timestamp: Date.now(),
        traceback: [],
      })
    }, timeoutMs)
  }

  private handleInterrupt(id: string): void {
    const pending = this.pendingExecs.get(id)
    if (!pending) {
      this.send({ id, type: "interrupted" })
      return
    }
    if (pending.timer) clearTimeout(pending.timer)
    // 保留 tracking：SIGINT 后设置升级定时器，忽略信号的进程在宽限期后
    // 被 SIGKILL，exit 事件触发 finish 收尾；立即回 interrupted 不阻塞调用方
    pending.timer = setTimeout(() => pending.kill("SIGKILL"), INTERRUPT_GRACE_MS)
    pending.kill("SIGINT")
    this.send({ id, type: "interrupted" })
  }

  private async handleFsRead(id: string, req: FsReadReq): Promise<void> {
    try {
      const mapper = this.session(req.sessionID)
      const filePath = mapper.toReal(req.path)
      const stat = await fs.stat(filePath)
      if (stat.isDirectory()) {
        const entries = await fs.readdir(filePath)
        this.send({ id, type: "fs.read.result", res: { data: entries.join("\n"), truncated: false } })
        return
      }
      // offset/limit 作用于原始字节（base64 场景先切字节再编码）
      let buf: Buffer
      if (req.range) {
        buf = await this.readRange(filePath, req.range)
      } else {
        buf = await fs.readFile(filePath)
      }
      const offset = Math.max(0, req.offset ?? 0)
      if (offset > 0) buf = buf.subarray(offset)
      let truncated = false
      if (req.limit !== undefined && buf.length > req.limit) {
        buf = buf.subarray(0, req.limit)
        truncated = true
      }
      const content = buf.toString(req.encoding === "base64" ? "base64" : "utf8")
      this.send({ id, type: "fs.read.result", res: { data: content, truncated } })
    } catch (err) {
      this.send({ id, type: "error", message: `fs.read failed: ${err instanceof Error ? err.message : String(err)}` })
    }
  }

  private async handleFsReadBytes(id: string, req: FsReadBytesReq): Promise<void> {
    try {
      const mapper = this.session(req.sessionID)
      const filePath = mapper.toReal(req.path)
      let buf: Buffer
      if (req.range) {
        buf = await this.readRange(filePath, req.range)
      } else {
        buf = await fs.readFile(filePath)
      }
      let truncated = false
      if (req.limit !== undefined && buf.length > req.limit) {
        buf = buf.subarray(0, req.limit)
        truncated = true
      }
      this.send({ id, type: "fs.readBytes.result", res: { data: buf.toString("base64"), truncated } })
    } catch (err) {
      this.send({ id, type: "error", message: `fs.readBytes failed: ${err instanceof Error ? err.message : String(err)}` })
    }
  }

  // 分片流式读取：512KB/块 base64 逐块回传，大文件避免全量驻留内存
  private async handleFsReadBytesStream(id: string, req: FsReadBytesReq): Promise<void> {
    try {
      const mapper = this.session(req.sessionID)
      const filePath = mapper.toReal(req.path)
      const stat = await fs.stat(filePath)
      const total = stat.size
      const start = req.offset ?? 0
      const end = Math.min(start + (req.limit ?? total - start), total)
      const fd = await fs.open(filePath, "r")
      const CHUNK = 512 * 1024
      try {
        for (let pos = start; pos < end; pos += CHUNK) {
          const len = Math.min(CHUNK, end - pos)
          const buf = Buffer.alloc(len)
          // 短读保护：网络文件系统可能一次读不满，循环补齐防尾部静默补零
          let filled = 0
          while (filled < len) {
            const { bytesRead } = await fd.read(buf, filled, len - filled, pos + filled)
            if (bytesRead === 0) break
            filled += bytesRead
          }
          this.send({
            id,
            type: "fs.readBytes.stream",
            chunk: buf.subarray(0, filled).toString("base64"),
            offset: pos,
            total,
          })
        }
      } finally {
        await fd.close()
      }
      console.log(`[read-stream] ${req.path} ${end - start}B`)
      this.send({ id, type: "fs.readBytes.result", res: { data: "", truncated: false } })
    } catch (err) {
      console.error(`[read-stream] failed ${req.path}:`, err instanceof Error ? err.message : err)
      this.send({ id, type: "error", message: `fs.readBytes.stream failed: ${err instanceof Error ? err.message : String(err)}` })
    }
  }

  private async handleFsWrite(id: string, req: FsWriteReq): Promise<void> {
    try {
      const mapper = this.session(req.sessionID)
      for (const entry of req.entries) {
        const filePath = mapper.toReal(entry.path)
        await fs.mkdir(path.dirname(filePath), { recursive: true })
        await fs.writeFile(filePath, entry.data, "utf8")
        console.log(`[write] ${entry.path} ${Buffer.byteLength(entry.data)}B`)
      }
      this.send({ id, type: "fs.write.result" })
    } catch (err) {
      console.error(`[write] failed ${req.entries.map((e) => e.path).join(",")}:`, err instanceof Error ? err.message : err)
      this.send({ id, type: "error", message: `fs.write failed: ${err instanceof Error ? err.message : String(err)}` })
    }
  }

  private async handleFsStat(id: string, req: FsStatReq): Promise<void> {
    try {
      const mapper = this.session(req.sessionID)
      const res: Record<string, { mode: number; size: number; mtime: number; isDirectory: boolean } | null> = {}
      for (const p of req.paths) {
        const realPath = mapper.toReal(p)
        try {
          const stat = await fs.stat(realPath)
          res[p] = {
            mode: stat.mode,
            size: stat.size,
            mtime: stat.mtimeMs,
            isDirectory: stat.isDirectory(),
          }
        } catch {
          res[p] = null
        }
      }
      this.send({ id, type: "fs.stat.result", res })
    } catch (err) {
      this.send({ id, type: "error", message: `fs.stat failed: ${err instanceof Error ? err.message : String(err)}` })
    }
  }

  private async handlePtyCreate(id: string, req: PtyCreateReq & { sessionID?: string }): Promise<void> {
    try {
      if (!this.ptyManager) {
        const { PtyManager } = await import("./pty-manager")
        this.ptyManager = new PtyManager(this.send.bind(this))
      }
      const cwd = this.session(req.sessionID ?? "default").toReal(req.cwd)
      const ptyId = await this.ptyManager.create({ ...req, cwd })
      this.send({ id, type: "pty.create.result", res: { ptyId } })
    } catch (err) {
      this.send({ id, type: "error", message: `pty.create failed: ${err instanceof Error ? err.message : String(err)}` })
    }
  }

  private handlePtyInput(ptyId: string, data: string): void {
    this.ptyManager?.input(ptyId, data)
  }

  private handlePtyResize(ptyId: string, cols: number, rows: number): void {
    this.ptyManager?.resize(ptyId, cols, rows)
  }

  private handlePtyKill(ptyId: string): void {
    this.ptyManager?.kill(ptyId)
  }

  private async handleEndpoint(id: string, port: number): Promise<void> {
    const url = `http://localhost:${port}`
    this.send({ id, type: "endpoint.result", res: { url } })
  }

  private async readRange(filePath: string, range: string): Promise<Buffer> {
    const stat = await fs.stat(filePath)
    const match = range.match(/^bytes=(\d+)-(\d*)$/)
    // 非法 range 直接报错：静默回退整读会让大文件请求绕过限制撑爆内存
    if (!match) throw new Error(`invalid range header: ${JSON.stringify(range)}`)
    const start = parseInt(match[1]!, 10)
    const end = Math.min(match[2] ? parseInt(match[2], 10) : stat.size - 1, stat.size - 1)
    const fd = await fs.open(filePath, "r")
    try {
      const buf = Buffer.alloc(Math.max(0, end - start + 1))
      // 短读保护：循环补齐，防尾部静默补零
      let filled = 0
      while (filled < buf.length) {
        const { bytesRead } = await fd.read(buf, filled, buf.length - filled, start + filled)
        if (bytesRead === 0) break
        filled += bytesRead
      }
      return buf.subarray(0, filled)
    } finally {
      await fd.close()
    }
  }

  dispose(): void {
    for (const [, pending] of this.pendingExecs) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.kill("SIGKILL")
    }
    this.pendingExecs.clear()
    this.ptyManager?.dispose()
  }
}
