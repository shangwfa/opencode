export type AgentMessage =
  | { id: string; type: "hello"; workdir: string; agentVersion: string }
  | { id: string; type: "hello.ack"; agentID: string }
  | { id: string; type: "exec"; req: ExecReq }
  | { id: string; type: "exec.stream"; stream: ExecStream }
  | { id: string; type: "exec.result"; res: CommandExecution }
  | { id: string; type: "interrupt" }
  | { id: string; type: "interrupted" }
  | { id: string; type: "fs.read"; req: FsReadReq }
  | { id: string; type: "fs.read.result"; res: FsReadRes }
  | { id: string; type: "fs.readBytes"; req: FsReadBytesReq }
  | { id: string; type: "fs.readBytes.result"; res: FsReadBytesRes }
  | { id: string; type: "fs.write"; req: FsWriteReq }
  | { id: string; type: "fs.write.result" }
  | { id: string; type: "fs.stat"; req: FsStatReq }
  | { id: string; type: "fs.stat.result"; res: FsStatRes }
  | { id: string; type: "pty.create"; req: PtyCreateReq }
  | { id: string; type: "pty.create.result"; res: { ptyId: string } }
  | { id: string; type: "pty.input"; ptyId: string; data: string }
  | { id: string; type: "pty.resize"; ptyId: string; cols: number; rows: number }
  | { id: string; type: "pty.kill"; ptyId: string }
  | { id: string; type: "pty.stream"; ptyId: string; stream: PtyStream }
  | { id: string; type: "endpoint"; req: { port: number } }
  | { id: string; type: "endpoint.result"; res: { url: string } }
  | { id: string; type: "health" }
  | { id: string; type: "health.result"; res: { ok: boolean } }
  | { id: string; type: "error"; message: string }

export type ExecReq = {
  cwd: string
  command: string
  timeoutMs?: number
  env?: Record<string, string>
}

export type ExecStream =
  | { event: "stdout"; text: string }
  | { event: "stderr"; text: string }

export type CommandExecution = {
  logs: { stdout: { text: string }[]; stderr: { text: string }[] }
  exitCode: number | null
  error?: { name: string; value: string; timestamp: number; traceback: string[] }
}

export type FsReadReq = {
  path: string
  encoding?: string
  range?: string
  offset?: number
  limit?: number
}

export type FsReadRes = {
  data: string
  truncated: boolean
}

export type FsReadBytesReq = {
  path: string
  range?: string
  offset?: number
  limit?: number
}

export type FsReadBytesRes = {
  data: string
  truncated: boolean
}

export type FsWriteReq = {
  entries: { path: string; data: string }[]
}

export type FsStatReq = {
  paths: string[]
}

export type FsStatRes = Record<
  string,
  { mode: number; size: number; mtime: number; isDirectory: boolean } | null
>

export type PtyCreateReq = {
  cwd: string
  cols: number
  rows: number
  env?: Record<string, string>
}

export type PtyStream =
  | { event: "output"; data: string }
  | { event: "exit"; exitCode: number }
