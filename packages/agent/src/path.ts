import * as path from "node:path"
import { basename, dirname, join } from "node:path"
import { mkdirSync, realpathSync } from "node:fs"

// 会话工作区隔离：每个 sessionID 独占 {root}/sessions/{sessionID}/ 目录，
// /workspace 虚拟前缀映射到各自子目录。toReal 做归一化 + realpath 双重
// 校验，越界路径（../ 穿越、symlink 逃逸、/workspace 外绝对路径）直接拒绝。
const SESSION_DIR = "sessions"
const SESSION_ID_RE = /^[\w-]{1,128}$/

// 把路径中已存在的部分收敛为 realpath；不存在的尾部（待写入的文件）保留
function realpathBestEffort(p: string): string {
  let probe = p
  const tail: string[] = []
  for (;;) {
    try {
      return join(realpathSync(probe), ...tail)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
      tail.unshift(basename(probe))
      const parent = dirname(probe)
      if (parent === probe) return p
      probe = parent
    }
  }
}

export class PathMapper {
  constructor(private root: string) {}

  get dir(): string {
    return this.root
  }

  forSession(sessionID: string): SessionMapper {
    // sessionID 白名单：防 ../.. 逃逸 sessions/ 根与注入
    if (!SESSION_ID_RE.test(sessionID)) throw new Error(`invalid sessionID: ${JSON.stringify(sessionID)}`)
    return new SessionMapper(path.join(this.root, SESSION_DIR, sessionID))
  }
}

export class SessionMapper {
  private workdir: string

  constructor(workdir: string) {
    // macOS /tmp → /private/tmp 等 symlink 场景：把存在的部分收敛为 realpath，
    // 保证后续 guard 的前缀比较基准一致
    this.workdir = realpathBestEffort(workdir)
  }

  get dir(): string {
    return this.workdir
  }

  ensure(): void {
    mkdirSync(this.workdir, { recursive: true })
    this.workdir = realpathSync(this.workdir)
  }

  private guard(real: string): string {
    // 归一化后收敛 realpath（防 symlink 逃逸），必须落在 workdir 内。
    // 目标可能尚不存在（如待写入的文件）：沿祖先找到第一个存在的路径再校验。
    let probe = real
    for (;;) {
      try {
        const resolved = realpathSync(probe)
        if (resolved !== this.workdir && !resolved.startsWith(this.workdir + path.sep)) {
          throw new Error(`path escapes session workspace: ${real} -> ${resolved}`)
        }
        return real
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== "ENOENT") throw err
        const parent = path.dirname(probe)
        if (parent === probe) throw new Error(`path escapes session workspace: ${real}`)
        probe = parent
      }
    }
  }

  toReal(sandboxPath: string): string {
    if (sandboxPath === "/workspace" || sandboxPath === "/workspace/") {
      return this.workdir
    }
    if (sandboxPath.startsWith("/workspace/")) {
      return this.guard(path.resolve(this.workdir, "." + sandboxPath.slice("/workspace".length)))
    }
    // /workspace 外的宿主机绝对路径一律拒绝（会话隔离边界）
    if (path.isAbsolute(sandboxPath)) {
      throw new Error(`absolute path outside /workspace is not allowed: ${sandboxPath}`)
    }
    return this.guard(path.resolve(this.workdir, sandboxPath))
  }

  // 命令字符串里的虚拟路径前缀重写为真实目录（如 shell 工具拼接的
  // `cd /workspace && ...`，宿主机上并不存在 /workspace）。
  rewriteCommand(command: string): string {
    return command.replace(/\/workspace\b/g, this.workdir)
  }
}
