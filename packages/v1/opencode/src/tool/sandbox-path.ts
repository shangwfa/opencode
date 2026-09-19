/**
 * Path mapping utilities between host and sandbox paths.
 *
 * The sandbox container maps its workspace to `/workspace`. These functions
 * provide bidirectional conversion so we can show host paths to the user
 * while using sandbox paths for API calls inside the container.
 */

/** The fixed working directory inside the sandbox container. */
export const SANDBOX_WORKDIR = "/workspace"

/**
 * Convert a host path to its sandbox equivalent.
 *
 * @param hostPath    - The path on the host machine.
 * @param hostWorkdir - The host's project working directory.
 * @returns The corresponding path inside the sandbox.
 */
export function toSandboxPath(hostPath: string, hostWorkdir: string): string {
  if (!hostPath || hostPath === ".") {
    return SANDBOX_WORKDIR
  }

  if (hostPath === "./") {
    return SANDBOX_WORKDIR + "/"
  }

  if (!hostPath.startsWith("/")) {
    const stripped = hostPath.startsWith("./") ? hostPath.slice(2) : hostPath
    return stripped ? `${SANDBOX_WORKDIR}/${stripped}` : SANDBOX_WORKDIR
  }

  if (isSandboxPath(hostPath)) return hostPath

  const normalisedWorkdir = hostWorkdir.endsWith("/")
    ? hostWorkdir.slice(0, -1)
    : hostWorkdir

  if (
    hostPath === normalisedWorkdir ||
    hostPath.startsWith(normalisedWorkdir + "/")
  ) {
    const suffix = hostPath.slice(normalisedWorkdir.length)
    return suffix ? `${SANDBOX_WORKDIR}${suffix}` : SANDBOX_WORKDIR
  }

  return hostPath
}

/**
 * Convert a sandbox path back to its host equivalent.
 *
 * @param sandboxPath - The path inside the sandbox.
 * @param hostWorkdir - The host's project working directory.
 * @returns The corresponding path on the host machine.
 */
export function toHostPath(sandboxPath: string, hostWorkdir: string): string {
  if (!sandboxPath) {
    return hostWorkdir
  }

  if (isSandboxPath(hostWorkdir)) return sandboxPath

  const normalisedWorkdir = hostWorkdir.endsWith("/")
    ? hostWorkdir.slice(0, -1)
    : hostWorkdir

  if (sandboxPath === SANDBOX_WORKDIR) {
    return normalisedWorkdir
  }

  if (sandboxPath.startsWith(SANDBOX_WORKDIR + "/")) {
    const suffix = sandboxPath.slice(SANDBOX_WORKDIR.length)
    return `${normalisedWorkdir}${suffix}`
  }

  return sandboxPath
}

/**
 * Check whether a path is a sandbox-internal path.
 *
 * @param filePath - The path to test.
 * @returns `true` if the path starts with {@link SANDBOX_WORKDIR}.
 */
export function isSandboxPath(filePath: string): boolean {
  if (!filePath) return false
  return (
    filePath === SANDBOX_WORKDIR || filePath.startsWith(SANDBOX_WORKDIR + "/")
  )
}

/**
 * Convert a host working directory to the sandbox equivalent for use as a
 * `cwd` argument when executing commands inside the sandbox.
 *
 * @param hostCwd     - The current working directory on the host, or
 *                      `undefined` to default to the sandbox root.
 * @param hostWorkdir - The host's project working directory.
 * @returns The corresponding sandbox directory path.
 */
export function toSandboxCwd(
  hostCwd: string | undefined,
  hostWorkdir: string,
): string {
  if (hostCwd === undefined || hostCwd === "") {
    return isSandboxPath(hostWorkdir) ? hostWorkdir : SANDBOX_WORKDIR
  }
  return toSandboxPath(hostCwd, hostWorkdir)
}
