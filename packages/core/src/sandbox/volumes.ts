export * as SandboxVolumes from "./volumes.js"

import type { Volume } from "@alibaba-group/opensandbox"
import type { SandboxConfig } from "./config.js"

export interface VolumeScope {
  readonly sessionID: string
  readonly pvcMode?: "session" | "app"
  readonly appId?: string
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
 * Volume mounts for one sandbox. `pvc` mode mounts every session directory as
 * a subPath of one PVC claim plus one cross-session package cache; `host` mode
 * bind-mounts per-session host paths (app scope is ignored, since host paths
 * are local to one node); `none` returns no volumes and the sandbox stays
 * ephemeral.
 */
export function buildVolumes(scope: VolumeScope, config: SandboxConfig.Config): Volume[] {
  if (config.volumeType === "none") return []
  if (scope.pvcMode === "app" && !scope.appId?.trim()) {
    throw new Error(`app 模式缺少 appId，拒绝创建 sandbox（sessionID=${scope.sessionID}）`)
  }
  const useApp = config.volumeType === "pvc" && scope.pvcMode === "app"
  const prefix = useApp ? `apps/${scope.appId!.trim()}` : `sessions/${scope.sessionID}`
  const mounts = mountSpecs(prefix)
  const result = mounts.map((m) => {
    const base: Volume = { name: m.name, mountPath: m.mountPath, subPath: m.sub }
    if (config.volumeType === "pvc") {
      base.pvc = { claimName: config.pvcClaimName }
    } else {
      base.host = { path: `/var/opencode/sessions/${scope.sessionID}/${m.name}` }
    }
    return base
  })
  if (config.volumeType === "pvc") {
    const packageCacheMount = requirePackageCacheMount(config.packageCacheMount, mounts.map((m) => m.mountPath))
    result.push({
      name: "package-cache",
      mountPath: packageCacheMount,
      subPath: "shared/package-cache",
      pvc: { claimName: config.pvcClaimName },
    })
  }
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
