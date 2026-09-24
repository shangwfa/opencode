export * as SandboxConfig from "./config.js"

/**
 * Deployment configuration for the OpenSandbox bridge, read once from the
 * environment when the provider layer is constructed. The SaaS control plane
 * injects these at container start; local development leaves
 * `OPENCODE_SANDBOX_ENABLED` unset so every tool keeps its local behavior.
 */

export interface Config {
  readonly enabled: boolean
  readonly domain: string
  readonly protocol: "http" | "https"
  readonly apiKey?: string
  readonly useServerProxy: boolean
  readonly image: string
  /** Remote sandbox TTL (seconds) when no volume is attached. */
  readonly timeoutSeconds: number
  /** Idle time before a running sandbox is reaped; 0 disables idle reap. */
  readonly idleReapSeconds: number
  /** Sandbox.create upper bound; first pulls of large images need headroom. */
  readonly createTimeoutSeconds: number
  /** CPU/memory request forwarded to the control plane. */
  readonly resource: { cpu: string; memory: string }
  /** Browser-reachable host for preview URLs; defaults to the request host. */
  readonly publicDomain?: string
  /** Volume backend for session workspaces; `none` keeps sandboxes ephemeral. */
  readonly volumeType: "none" | "pvc" | "host"
  /** PVC claim backing all volume mounts when volumeType is `pvc`. */
  readonly pvcClaimName: string
  /** Cross-session shared package-cache mount point (PVC volumeType only). */
  readonly packageCacheMount: string
}

const DEFAULT_IMAGE = "registry.cn-hangzhou.aliyuncs.com/opensandbox/opencode-sandbox:latest"

const flag = (value: string | undefined) => value === "true" || value === "1"

const volumeType = (value: string | undefined): Config["volumeType"] =>
  value === "pvc" || value === "host" ? value : "none"

const number = (value: string | undefined, fallback: number) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function load(): Config {
  const env = process.env
  return {
    enabled: flag(env["OPENCODE_SANDBOX_ENABLED"]),
    domain: env["OPENCODE_SANDBOX_DOMAIN"] ?? "",
    protocol: env["OPENCODE_SANDBOX_PROTOCOL"] === "http" ? "http" : "https",
    apiKey: env["OPENCODE_SANDBOX_API_KEY"] || undefined,
    useServerProxy: flag(env["OPENCODE_SANDBOX_USE_SERVER_PROXY"]),
    image: env["OPENCODE_SANDBOX_IMAGE"] || DEFAULT_IMAGE,
    timeoutSeconds: number(env["OPENCODE_SANDBOX_TIMEOUT_SECONDS"], 30 * 60),
    idleReapSeconds:
      env["OPENCODE_SANDBOX_IDLE_REAP_SEC"] === "0" ? 0 : number(env["OPENCODE_SANDBOX_IDLE_REAP_SEC"], 60 * 60),
    createTimeoutSeconds: number(env["OPENCODE_SANDBOX_CREATE_TIMEOUT_SECONDS"], 300),
    resource: {
      cpu: env["OPENCODE_SANDBOX_CPU"] || "2",
      memory: env["OPENCODE_SANDBOX_MEMORY"] || "4Gi",
    },
    publicDomain: env["OPENCODE_SANDBOX_PUBLIC_DOMAIN"] || undefined,
    volumeType: volumeType(env["OPENCODE_SANDBOX_VOLUME_TYPE"]),
    pvcClaimName: env["OPENCODE_SANDBOX_PVC_CLAIM"] || "sandbox-test",
    packageCacheMount: env["OPENCODE_SANDBOX_PACKAGE_CACHE_MOUNT"] || "/opt/pnpm-store",
  }
}
