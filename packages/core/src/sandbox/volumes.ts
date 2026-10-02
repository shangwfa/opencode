export * as SandboxVolumes from "./volumes.js"

import type { Volume } from "@alibaba-group/opensandbox"
import type { SandboxConfig } from "./config.js"

export interface VolumeScope {
  readonly sessionID: string
  readonly pvcMode?: "session" | "app"
  readonly appId?: string
  /** Session-level persistence override; the deployment default applies when omitted. */
  readonly persistMode?: "pvc" | "snapshot" | "none"
}

interface MountSpec {
  readonly name: string
  readonly mountPath: string
  readonly sub: string
}

/**
 * All session-persistent directories that survive sandbox recycling. The
 * prefix selects the sharing scope: `apps/{appId}` is shared by every session
 * of the app, `sessions/{sessionID}` isolates one session.
 */
const mountSpecs = (prefix: string): readonly MountSpec[] => [
  { name: "workspace", mountPath: "/workspace", sub: `${prefix}/workspace` },
  { name: "resources", mountPath: "/resources", sub: `${prefix}/resources` },
  { name: "home", mountPath: "/home/sandbox", sub: `${prefix}/home` },
  { name: "cache", mountPath: "/home/sandbox/.cache", sub: `${prefix}/cache` },
  { name: "config", mountPath: "/home/sandbox/.config", sub: `${prefix}/config` },
  { name: "local", mountPath: "/home/sandbox/.local", sub: `${prefix}/local` },
  { name: "tmp", mountPath: "/home/sandbox/tmp", sub: `${prefix}/tmp` },
]

/**
 * Volume mounts for one sandbox. The PVC backend mounts every session directory
 * as a subPath of one PVC claim plus one cross-session package cache; the
 * sharing scope comes from `pvcMode` (`app` shares `apps/{appId}`, otherwise
 * `sessions/{sessionID}`). A session-level `none` persist mode keeps this one
 * sandbox ephemeral, and `snapshot` mounts no volumes either — the workspace
 * lives on the sandbox rootfs and persists through snapshots taken before
 * recycle.
 */
export function buildVolumes(scope: VolumeScope, config: SandboxConfig.Config): Volume[] {
  const volumeType = scope.persistMode ?? config.volumeType
  if (volumeType === "none" || volumeType === "snapshot") return []
  if (scope.pvcMode === "app" && !scope.appId?.trim()) {
    throw new Error(`app 模式缺少 appId，拒绝创建 sandbox（sessionID=${scope.sessionID}）`)
  }
  // The only surviving backend is PVC: one claim per sandbox, subPath selects
  // the sharing scope.
  const prefix = scope.pvcMode === "app" ? `apps/${scope.appId!.trim()}` : `sessions/${scope.sessionID}`
  const mounts = mountSpecs(prefix)
  const result: Volume[] = mounts.map((m) => ({
    name: m.name,
    mountPath: m.mountPath,
    subPath: m.sub,
    pvc: { claimName: config.pvcClaimName },
  }))
  const packageCacheMount = requirePackageCacheMount(config.packageCacheMount, mounts.map((m) => m.mountPath))
  result.push({
    name: "package-cache",
    mountPath: packageCacheMount,
    subPath: "shared/package-cache",
    pvc: { claimName: config.pvcClaimName },
  })
  return result
}

function requirePackageCacheMount(mountPath: string, reservedPaths: string[]) {
  const trimmed = mountPath.trim()
  const normalized = trimmed === "/" ? trimmed : trimmed.replace(/\/+$/, "")
  if (!normalized.startsWith("/") || normalized === "") {
    throw new Error(`OPENCODE_SANDBOX_PACKAGE_CACHE_MOUNT must be an absolute path, got ${JSON.stringify(mountPath)}`)
  }
  if (normalized === "/") {
    throw new Error("OPENCODE_SANDBOX_PACKAGE_CACHE_MOUNT cannot be /")
  }
  const conflict = reservedPaths.find(
    (reserved) => normalized === reserved || normalized.startsWith(`${reserved}/`) || reserved.startsWith(`${normalized}/`),
  )
  if (conflict) {
    throw new Error(`OPENCODE_SANDBOX_PACKAGE_CACHE_MOUNT conflicts with reserved mount path ${conflict}`)
  }
  return normalized
}
