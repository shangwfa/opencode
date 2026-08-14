import { spawn, type ChildProcess } from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { PathMapper } from "./path"
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
} from "./protocol"

type PendingExec = {
  proc: ChildProcess
  stdout: { text: string }[]
  stderr: { text: string }[]
  timer?: ReturnType<typeof setTimeout>
}

export class AgentHandler {
  private ptyManager: PtyManager | null = null
  private pendingExecs = new Map<string, PendingExec>()

  constructor(
    private mapper: PathMapper,
    private send: (msg: AgentMessage) => void,
  ) {}

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
    }
  }

  private handleExec(id: string, req: ExecReq): void {
    const cwd = this.mapper.toReal(req.cwd)
    const proc = spawn("sh", ["-c", this.mapper.rewriteCommand(req.command)], {
      cwd,
      env: { ...process.env, ...req.env },
      stdio: ["pipe", "pipe", "pipe"],
    })

    const pending: PendingExec = { proc, stdout: [], stderr: [] }
    this.pendingExecs.set(id, pending)

    proc.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8")
      pending.stdout.push({ text })
      this.send({ id, type: "exec.stream", stream: { event: "stdout", text } })
    })

    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8")
      pending.stderr.push({ text })
      this.send({ id, type: "exec.stream", stream: { event: "stderr", text } })
    })

    const finish = (exitCode: number | null, error?: CommandExecution["error"]) => {
      if (pending.timer) clearTimeout(pending.timer)
      this.pendingExecs.delete(id)
      this.send({
        id,
        type: "exec.result",
        res: { logs: { stdout: pending.stdout, stderr: pending.stderr }, exitCode, error },
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

    proc.on("exit", (code) => {
      finish(code)
    })

    if (req.timeoutMs) {
      pending.timer = setTimeout(() => {
        proc.kill("SIGKILL")
        finish(null, {
          name: "TimeoutError",
          value: `Command timed out after ${req.timeoutMs}ms`,
          timestamp: Date.now(),
          traceback: [],
        })
      }, req.timeoutMs)
    }
  }

  private handleInterrupt(id: string): void {
    const pending = this.pendingExecs.get(id)
    if (!pending) {
      this.send({ id, type: "interrupted" })
      return
    }
    if (pending.timer) clearTimeout(pending.timer)
    pending.proc.kill("SIGINT")
    this.pendingExecs.delete(id)
    this.send({ id, type: "interrupted" })
  }

  private async handleFsRead(id: string, req: FsReadReq): Promise<void> {
    try {
      const filePath = this.mapper.toReal(req.path)
      const stat = await fs.stat(filePath)
      if (stat.isDirectory()) {
        const entries = await fs.readdir(filePath)
        this.send({ id, type: "fs.read.result", res: { data: entries.join("\n"), truncated: false } })
        return
      }
      let content: string
      if (req.range) {
        const buf = await this.readRange(filePath, req.range)
        content = buf.toString(req.encoding === "base64" ? "base64" : "utf8")
      } else {
        content = await fs.readFile(filePath, (req.encoding as BufferEncoding) ?? "utf8")
      }
      let truncated = false
      if (req.limit !== undefined && content.length > req.limit) {
        content = content.slice(0, req.limit)
        truncated = true
      }
      this.send({ id, type: "fs.read.result", res: { data: content, truncated } })
    } catch (err) {
      this.send({ id, type: "error", message: `fs.read failed: ${err instanceof Error ? err.message : String(err)}` })
    }
  }

  private async handleFsReadBytes(id: string, req: FsReadBytesReq): Promise<void> {
    try {
      const filePath = this.mapper.toReal(req.path)
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

  private async handleFsWrite(id: string, req: FsWriteReq): Promise<void> {
    try {
      for (const entry of req.entries) {
        const filePath = this.mapper.toReal(entry.path)
        await fs.mkdir(path.dirname(filePath), { recursive: true })
        await fs.writeFile(filePath, entry.data, "utf8")
      }
      this.send({ id, type: "fs.write.result" })
    } catch (err) {
      this.send({ id, type: "error", message: `fs.write failed: ${err instanceof Error ? err.message : String(err)}` })
    }
  }

  private async handleFsStat(id: string, req: FsStatReq): Promise<void> {
    try {
      const res: Record<string, { mode: number; size: number; mtime: number; isDirectory: boolean } | null> = {}
      for (const p of req.paths) {
        const realPath = this.mapper.toReal(p)
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

  private async handlePtyCreate(id: string, req: PtyCreateReq): Promise<void> {
    try {
      if (!this.ptyManager) {
        const { PtyManager } = await import("./pty-manager")
        this.ptyManager = new PtyManager(this.send.bind(this))
      }
      const cwd = this.mapper.toReal(req.cwd)
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
    if (!match) return fs.readFile(filePath)
    const start = parseInt(match[1], 10)
    const end = match[2] ? parseInt(match[2], 10) : stat.size - 1
    const fd = await fs.open(filePath, "r")
    try {
      const buf = Buffer.alloc(end - start + 1)
      await fd.read(buf, 0, buf.length, start)
      return buf
    } finally {
      await fd.close()
    }
  }

  dispose(): void {
    for (const [, pending] of this.pendingExecs) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.proc.kill("SIGKILL")
    }
    this.pendingExecs.clear()
    this.ptyManager?.dispose()
  }
}
