import * as path from "node:path"
import { mkdirSync } from "node:fs"

// 会话工作区隔离：每个 sessionID 独占 {root}/sessions/{sessionID}/ 目录，
// /workspace 虚拟前缀映射到各自子目录，会话之间互不可见。
const SESSION_DIR = "sessions"

export class PathMapper {
  constructor(private root: string) {}

  get dir(): string {
    return this.root
  }

  forSession(sessionID: string): SessionMapper {
    return new SessionMapper(path.join(this.root, SESSION_DIR, sessionID))
  }
}

export class SessionMapper {
  constructor(private workdir: string) {}

  get dir(): string {
    return this.workdir
  }

  ensure(): void {
    mkdirSync(this.workdir, { recursive: true })
  }

  toReal(sandboxPath: string): string {
    if (sandboxPath === "/workspace" || sandboxPath === "/workspace/") {
      return this.workdir
    }
    if (sandboxPath.startsWith("/workspace/")) {
      return path.join(this.workdir, sandboxPath.slice("/workspace/".length))
    }
    return sandboxPath
  }

  // 命令字符串里的虚拟路径前缀重写为真实目录（如 shell 工具拼接的
  // `cd /workspace && ...`，宿主机上并不存在 /workspace）。
  rewriteCommand(command: string): string {
    return command.replace(/\/workspace\b/g, this.workdir)
  }
}
