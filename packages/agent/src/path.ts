import * as path from "node:path"
import { mkdirSync, realpathSync, lstatSync } from "node:fs"

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
      return path.join(realpathSync(probe), ...tail)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
      tail.unshift(path.basename(probe))
      const parent = path.dirname(probe)
      if (parent === probe) return p
      probe = parent
    }
  }
}

// 下探式校验 candidate（位于 bound 下）：逐段 lstat，symlink 解析后必须
// 仍落在 bound 内。防「预置 sessions/{id} -> /etc」劫持隔离根（L2.2）；
// 上探式 realpath 无法区分「root 本身尚未创建」与「被 symlink 移出」。
function resolveBounded(candidate: string, bound: string): string {
  const rel = path.relative(bound, candidate)
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path escapes sandbox root: ${candidate}`)
  }
  const parts = rel ? rel.split(path.sep) : []
  let base = bound
  for (let i = 0; i < parts.length; i++) {
    const current = path.join(base, parts[i]!)
    let stat: { isSymbolicLink(): boolean }
    try {
      stat = lstatSync(current)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
      // 余下各级尚不存在，将由 mkdirSync 创建为实体目录
      return path.join(current, ...parts.slice(i + 1))
    }
    if (stat.isSymbolicLink()) {
      const real = realpathSync(current)
      if (real !== bound && !real.startsWith(bound + path.sep)) {
        throw new Error(`path escapes sandbox root: ${candidate} -> ${real}`)
      }
      base = real
    } else {
      base = current
    }
  }
  return base
}

export class PathMapper {
  private realRoot: string

  constructor(root: string) {
    // macOS /tmp → /private/tmp 等 symlink 场景：先收敛 root 自身，
    // 保证后续 bound 比较基准一致
    this.realRoot = realpathBestEffort(root)
  }

  get dir(): string {
    return this.realRoot
  }

  forSession(sessionID: string): SessionMapper {
    // sessionID 白名单：防 ../.. 逃逸 sessions/ 根与注入
    if (!SESSION_ID_RE.test(sessionID)) throw new Error(`invalid sessionID: ${JSON.stringify(sessionID)}`)
    return new SessionMapper(resolveBounded(path.join(this.realRoot, SESSION_DIR, sessionID), this.realRoot))
  }
}

export class SessionMapper {
  constructor(private workdir: string) {}

  get dir(): string {
    return this.workdir
  }

  ensure(): void {
    mkdirSync(this.workdir, { recursive: true })
    // 创建后必须仍是预期实体路径：mkdir 递归途中任何一级被换成指向外部的
    // symlink 都会被 realpath 揭露（构造期校验的 TOCTOU 补丁）
    const real = realpathSync(this.workdir)
    if (real !== this.workdir) {
      throw new Error(`session workspace resolved outside sandbox root: ${this.workdir} -> ${real}`)
    }
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
  // (?![\w-])：只替换独立路径段，/workspace-old、/workspace2 不命中；
  // 真实目录含空格等 shell 元字符时加引号防拆词。
  rewriteCommand(command: string): string {
    const needsQuote = /[^-\w/.]/.test(this.workdir)
    const replacement = needsQuote ? `"${this.workdir.replace(/([$"\\`])/g, "\\$1")}"` : this.workdir
    return command.replace(/\/workspace(?![-\w])/g, replacement)
  }
}
