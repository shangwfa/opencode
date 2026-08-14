import type { AgentMessage } from "./protocol"

type PtyEntry = {
  pty: {
    write(data: string): void
    resize(cols: number, rows: number): void
    kill(signal?: string): void
    onData(cb: (data: string) => void): void
    onExit(cb: (info: { exitCode: number }) => void): void
  }
  ptyId: string
}

export class PtyManager {
  private entries = new Map<string, PtyEntry>()
  private ptyModule: typeof import("node-pty") | null = null

  constructor(private send: (msg: AgentMessage) => void) {}

  private async loadPty() {
    if (!this.ptyModule) {
      this.ptyModule = await import("node-pty")
    }
    return this.ptyModule
  }

  async create(opts: {
    cwd: string
    cols: number
    rows: number
    env?: Record<string, string>
  }): Promise<string> {
    const ptyMod = await this.loadPty()
    const pty = ptyMod.spawn(process.env.SHELL || "bash", [], {
      cwd: opts.cwd,
      cols: opts.cols,
      rows: opts.rows,
      env: { ...process.env, ...opts.env } as Record<string, string>,
    })
    const ptyId = `pty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const entry: PtyEntry = { pty, ptyId }
    this.entries.set(ptyId, entry)

    pty.onData((data) => {
      this.send({ id: ptyId, type: "pty.stream", ptyId, stream: { event: "output", data: Buffer.from(data).toString("base64") } })
    })

    pty.onExit(({ exitCode }) => {
      this.send({ id: ptyId, type: "pty.stream", ptyId, stream: { event: "exit", exitCode } })
      this.entries.delete(ptyId)
    })

    return ptyId
  }

  input(ptyId: string, data: string): void {
    const entry = this.entries.get(ptyId)
    if (entry) entry.pty.write(Buffer.from(data, "base64").toString("utf8"))
  }

  resize(ptyId: string, cols: number, rows: number): void {
    const entry = this.entries.get(ptyId)
    if (entry) entry.pty.resize(cols, rows)
  }

  kill(ptyId: string): void {
    const entry = this.entries.get(ptyId)
    if (entry) {
      entry.pty.kill()
      this.entries.delete(ptyId)
    }
  }

  dispose(): void {
    for (const [, entry] of this.entries) {
      entry.pty.kill()
    }
    this.entries.clear()
  }
}
