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
  /**
   * MCP-only endpoint override: when true, MCP connections resolve through the
   * OpenSandbox server gateway even if `useServerProxy` is false. Defaults to
   * true so cross-network deployments never dial sandbox addresses directly.
   */
  readonly mcpServerProxy: boolean
  readonly image: string
  /** Remote sandbox TTL (seconds) when no volume is attached. */
  readonly timeoutSeconds: number
  /** Idle time before a running sandbox is reaped; 0 disables idle reap. */
  readonly idleReapSeconds: number
  /** Sandbox.create upper bound; first pulls of large images need headroom. */
  readonly createTimeoutSeconds: number
  /** Per-attempt timeout for Sandbox files API reads. */
  readonly filesTimeoutSeconds: number
  /** Number of retries after a files API read times out. */
  readonly filesTimeoutRetries: number
  /** CPU/memory request forwarded to the control plane. */
  readonly resource: { cpu: string; memory: string }
  /** Browser-reachable host for preview URLs; defaults to the request host. */
  readonly publicDomain?: string
  /** Volume backend for session workspaces. Only two backends exist: `pvc`
   * (default, V1 parity — all seven session directories plus the package cache
   * mount as subPaths of one PVC claim) and `snapshot` (workspace stays on the
   * sandbox rootfs and persists via snapshots taken before recycle). Any other
   * or missing env value falls back to `pvc`. */
  readonly volumeType: "pvc" | "snapshot"
  /** PVC claim backing all volume mounts when volumeType is `pvc`. */
  readonly pvcClaimName: string
  /** Cross-session shared package-cache mount point (PVC volumeType only). */
  readonly packageCacheMount: string
  /** Per-Session bound for isolated command contexts such as Code Mode. */
  readonly maxConcurrentCommandsPerSession: number
  /** Process-wide bound for isolated command contexts. */
  readonly maxConcurrentCommandsGlobal: number
  /** Periodic OOM sampling of running sandboxes (see sandbox/oom-sample.ts). */
  readonly oomScan: {
    readonly enabled: boolean
    readonly intervalSeconds: number
    readonly batch: number
    readonly pressureRatio: number
  }
  /** Sandbox snapshot persistence (see sandbox/snapshot.ts and docs/sandbox-snapshot-design.md). */
  readonly snapshot: {
    /** Master switch; snapshot requests for sessions without the persist mode return an error when off. */
    readonly enabled: boolean
    /** Retention before GC marks terminal snapshots deleted (default 14 days). */
    readonly ttlMs: number
    /** Upper bound for waiting a snapshot to become Ready (default 15 minutes). */
    readonly waitMs: number
    /** Physical remote deletion gate (default off: keep snapshots, let remote TTL reap them). */
    readonly deleteEnabled: boolean
    /** Idle window after which a running snapshot-persisted sandbox gets its snapshot refreshed
     * in place (sandbox kept alive); 0 disables periodic refresh. Defaults to on (V1 parity):
     * without it, a platform hard-kill of a long-idle sandbox loses every write
     * since the last snapshot. */
    readonly refreshSeconds: number
    /** Prune rebuildable caches before taking a snapshot (workspace size is still measured). */
    readonly prune: boolean
  }
}

const DEFAULT_IMAGE = "registry.cn-hangzhou.aliyuncs.com/opensandbox/opencode-sandbox:latest"

const flag = (value: string | undefined) => value === "true" || value === "1"

// V1 parity: `pvc` is the only default. Only an explicit `snapshot` selects the
// snapshot backend; unset, empty, `none`, `host`, and unknown values all fall
// back to `pvc` so a misconfigured deployment never silently loses persistence.
const volumeType = (value: string | undefined): Config["volumeType"] =>
  value === "snapshot" ? "snapshot" : "pvc"

const number = (value: string | undefined, fallback: number) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const integer = (value: string | undefined, fallback: number) => {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

const nonNegativeInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback
}

export function load(): Config {
  const env = process.env
  return {
    enabled: flag(env["OPENCODE_SANDBOX_ENABLED"]),
    domain: env["OPENCODE_SANDBOX_DOMAIN"] ?? "",
    protocol: env["OPENCODE_SANDBOX_PROTOCOL"] === "http" ? "http" : "https",
    apiKey: env["OPENCODE_SANDBOX_API_KEY"] || undefined,
    useServerProxy: flag(env["OPENCODE_SANDBOX_USE_SERVER_PROXY"]),
    // Unset defaults to true (gateway); an explicit value opts into/out of it.
    mcpServerProxy:
      env["OPENCODE_SANDBOX_MCP_SERVER_PROXY"] === undefined ? true : flag(env["OPENCODE_SANDBOX_MCP_SERVER_PROXY"]),
    image: env["OPENCODE_SANDBOX_IMAGE"] || DEFAULT_IMAGE,
    timeoutSeconds: number(env["OPENCODE_SANDBOX_TIMEOUT_SECONDS"], 30 * 60),
    idleReapSeconds:
      env["OPENCODE_SANDBOX_IDLE_REAP_SEC"] === "0" ? 0 : number(env["OPENCODE_SANDBOX_IDLE_REAP_SEC"], 60 * 60),
    createTimeoutSeconds: number(env["OPENCODE_SANDBOX_CREATE_TIMEOUT_SECONDS"], 300),
    filesTimeoutSeconds: integer(env["OPENCODE_SANDBOX_FILES_TIMEOUT_SECONDS"], 15),
    filesTimeoutRetries: nonNegativeInteger(env["OPENCODE_SANDBOX_FILES_TIMEOUT_RETRIES"], 1),
    resource: {
      cpu: env["OPENCODE_SANDBOX_CPU"] || "2",
      memory: env["OPENCODE_SANDBOX_MEMORY"] || "4Gi",
    },
    publicDomain: env["OPENCODE_SANDBOX_PUBLIC_DOMAIN"] || undefined,
    volumeType: volumeType(env["OPENCODE_SANDBOX_VOLUME_TYPE"]),
    pvcClaimName: env["OPENCODE_SANDBOX_PVC_CLAIM"] || "sandbox-test",
    packageCacheMount: env["OPENCODE_SANDBOX_PACKAGE_CACHE_MOUNT"] || "/opt/pnpm-store",
    maxConcurrentCommandsPerSession: number(env["OPENCODE_SANDBOX_MAX_CONCURRENT_COMMANDS_PER_SESSION"], 4),
    maxConcurrentCommandsGlobal: number(env["OPENCODE_SANDBOX_MAX_CONCURRENT_COMMANDS_GLOBAL"], 64),
    oomScan: {
      // Unset defaults to enabled; an explicit "0"/"false" opts out.
      enabled:
        env["OPENCODE_SANDBOX_OOM_SCAN_ENABLED"] === undefined
          ? true
          : env["OPENCODE_SANDBOX_OOM_SCAN_ENABLED"] !== "0" && env["OPENCODE_SANDBOX_OOM_SCAN_ENABLED"] !== "false",
      intervalSeconds: number(env["OPENCODE_SANDBOX_OOM_SCAN_INTERVAL_SEC"], 60),
      batch: number(env["OPENCODE_SANDBOX_OOM_SCAN_BATCH"], 50),
      pressureRatio: number(env["OPENCODE_SANDBOX_OOM_PRESSURE_RATIO"], 0.85),
    },
    snapshot: {
      enabled: flag(env["OPENCODE_SANDBOX_SNAPSHOT_ENABLED"]),
      ttlMs: number(env["OPENCODE_SANDBOX_SNAPSHOT_TTL_SEC"], 14 * 24 * 3600) * 1000,
      waitMs: number(env["OPENCODE_SANDBOX_SNAPSHOT_WAIT_SEC"], 900) * 1000,
      deleteEnabled: flag(env["OPENCODE_SANDBOX_SNAPSHOT_DELETE_ENABLED"]),
      // V1 parity: periodic refresh defaults to ON (1800s). Explicit "0" opts out.
      refreshSeconds:
        env["OPENCODE_SANDBOX_SNAPSHOT_REFRESH_SEC"] === "0"
          ? 0
          : number(env["OPENCODE_SANDBOX_SNAPSHOT_REFRESH_SEC"], 1800),
      prune: flag(env["OPENCODE_SANDBOX_SNAPSHOT_PRUNE"]),
    },
  }
}
