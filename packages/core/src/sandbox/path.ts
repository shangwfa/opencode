export * as SandboxPath from "./path.js"

/**
 * Path mapping between host (server) paths and the sandbox container's fixed
 * workspace mount at `/workspace`. The sandbox is the execution surface, so
 * every tool path must be translated before it reaches the sandbox API, and
 * sandbox-reported paths must be translated back before they reach the user.
 */

/** Fixed working directory inside the sandbox container. */
export const WORKDIR = "/workspace"

export function toSandboxPath(hostPath: string, hostWorkdir: string): string {
  if (!hostPath || hostPath === ".") return WORKDIR
  if (hostPath === "./") return `${WORKDIR}/`
  if (isSandboxPath(hostPath)) return hostPath
  if (!hostPath.startsWith("/")) {
    const stripped = hostPath.startsWith("./") ? hostPath.slice(2) : hostPath
    return stripped ? `${WORKDIR}/${stripped}` : WORKDIR
  }
  const workdir = trimTrailingSlash(hostWorkdir)
  if (hostPath === workdir || hostPath.startsWith(`${workdir}/`)) {
    const suffix = hostPath.slice(workdir.length)
    return suffix ? `${WORKDIR}${suffix}` : WORKDIR
  }
  return hostPath
}

export function toHostPath(sandboxPath: string, hostWorkdir: string): string {
  if (!sandboxPath) return hostWorkdir
  if (isSandboxPath(hostWorkdir)) return sandboxPath
  const workdir = trimTrailingSlash(hostWorkdir)
  if (sandboxPath === WORKDIR) return workdir
  if (sandboxPath.startsWith(`${WORKDIR}/`)) return `${workdir}${sandboxPath.slice(WORKDIR.length)}`
  return sandboxPath
}

export function isSandboxPath(filePath: string): boolean {
  return filePath === WORKDIR || filePath.startsWith(`${WORKDIR}/`)
}

/** Map a host working directory to the sandbox cwd for command execution. */
export function toSandboxCwd(hostCwd: string | undefined, hostWorkdir: string): string {
  if (hostCwd === undefined || hostCwd === "") return isSandboxPath(hostWorkdir) ? hostWorkdir : WORKDIR
  return toSandboxPath(hostCwd, hostWorkdir)
}

const trimTrailingSlash = (value: string) => (value.endsWith("/") ? value.slice(0, -1) : value)
