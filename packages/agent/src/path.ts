import * as path from "node:path"

export class PathMapper {
  constructor(private workdir: string) {}

  get dir(): string {
    return this.workdir
  }

  // 命令字符串里的虚拟路径前缀重写为真实目录（如 shell 工具拼接的
  // `cd /workspace && ...`，宿主机上并不存在 /workspace）。
  rewriteCommand(command: string): string {
    return command.replace(/\/workspace\b/g, this.workdir)
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

  toSandbox(realPath: string): string {
    const rel = path.relative(this.workdir, realPath)
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      return "/workspace/" + rel
    }
    return realPath
  }
}
