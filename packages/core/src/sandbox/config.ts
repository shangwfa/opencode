export * as SandboxConfig from "./config.js"

/**
 * Deployment configuration for the OpenSandbox bridge, read once from the
 * environment when the provider layer is constructed. The SaaS control plane
 * injects these at container start; local development leaves
 * `OPENCODE_SANDBOX_ENABLED` unset so every tool keeps its local behavior.
 */

export interface Config {
  readonly enabled: boolean
  readonly provider: "opensandbox" | "vercel" | "aliyun"
  readonly aliyun?: {
    readonly apiKey: string
    readonly apiUrl: string
    readonly domain: string
    readonly template: string
    /** Account must have pause/resume enabled; never fall back to killing a persistent workspace. */
    readonly pauseEnabled: boolean
    readonly runnerAsset?: string
    readonly installRipgrep?: boolean
  }
  readonly vercel?: {
    readonly token: string
    readonly teamId: string
    readonly projectId: string
    readonly image: string
    /** Host-side path to the gzipped Code Mode runner bundle (stock Vercel images lack /opt tooling). */
    readonly runnerAsset?: string
    /** Install ripgrep on boot when the stock image lacks it; glob/grep depend on rg. */
    readonly installRipgrep?: boolean
  }
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
  /** Remote sandbox TTL (seconds) when no volume is attached (V1 default 600). */
  readonly timeoutSeconds: number
  /** Remote sandbox TTL (seconds) for volume-attached sandboxes and the floor
   * for keep-alive TTL scaling (V1: hasVolume ? maxTtl : timeout; keepAlive →
   * max(base, maxTtl) × 10 so a kept-alive sandbox never suicides underneath
   * periodic snapshot refresh). */
  readonly maxTtlSeconds: number
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
  /** OpenSandbox snapshot persistence (see opensandbox/snapshot/index.ts). */
  readonly snapshot: {
    /** Master switch; snapshot requests for sessions without the persist mode return an error when off. */
    readonly enabled: boolean
    /** Retention before GC marks terminal snapshots deleted (default 14 days). */
    readonly ttlMs: number
    /** Upper bound for waiting a snapshot to become Ready (default 15 minutes). */
    readonly waitMs: number
    /** Physical remote deletion gate (default off: keep snapshots, let remote TTL reap them). */
    readonly deleteEnabled: boolean
    /** Target checkpoint interval for a running snapshot-persisted sandbox (active or idle), refreshed
     * in place (sandbox kept alive); 0 disables periodic refresh. Defaults to on (V1 parity):
     * without it, a platform hard-kill of a long-idle sandbox loses every write
     * since the last snapshot. The effective value is clamped to 1/3 of the
      * sandbox TTL floor as a scheduling heuristic, not a durability guarantee:
      * queue delay, commit latency and platform TTL semantics still matter. */
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

/** Switching the new-session provider must not change legacy OpenSandbox's PVC default. */
export const forOpenSandbox = (config: Config): Config => ({
  ...config,
  provider: "opensandbox",
  volumeType: volumeType(process.env["OPENCODE_SANDBOX_VOLUME_TYPE"]),
})

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
  const provider = env["OPENCODE_SANDBOX_PROVIDER"] || "opensandbox"
  if (provider !== "opensandbox" && provider !== "vercel" && provider !== "aliyun") throw new Error("Unknown sandbox provider")
  const aliyunKey = env["OPENCODE_ALIYUN_API_KEY"]?.trim()
  const aliyunDomain = env["OPENCODE_ALIYUN_DOMAIN"]?.trim()
  const aliyunUrl = env["OPENCODE_ALIYUN_API_URL"]?.trim()
  if (aliyunKey && aliyunDomain && aliyunUrl) {
    const url = new URL(aliyunUrl)
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      !/^[a-z0-9.-]+$/i.test(aliyunDomain) || url.hostname !== `api.${aliyunDomain}`) {
      throw new Error("Aliyun sandbox requires matching HTTPS API URL and domain, without credentials or paths")
    }
  }
  if (flag(env["OPENCODE_SANDBOX_ENABLED"]) && provider === "aliyun") {
    if (!aliyunKey || !aliyunDomain || !aliyunUrl) throw new Error("Aliyun sandbox requires OPENCODE_ALIYUN_API_KEY, OPENCODE_ALIYUN_API_URL and OPENCODE_ALIYUN_DOMAIN")
    if (env["OPENCODE_SANDBOX_VOLUME_TYPE"] && env["OPENCODE_SANDBOX_VOLUME_TYPE"] !== "snapshot")
      throw new Error("Aliyun sandbox does not support OpenSandbox PVC persistence")
  }
  const token = env["VERCEL_TOKEN"]?.trim()
  const teamId = env["VERCEL_TEAM_ID"]?.trim()
  const projectId = env["VERCEL_PROJECT_ID"]?.trim()
  if (flag(env["OPENCODE_SANDBOX_ENABLED"]) && provider === "vercel") {
    if (!token || !teamId || !projectId) throw new Error("Vercel sandbox requires VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID")
    if (env["OPENCODE_SANDBOX_VOLUME_TYPE"] && env["OPENCODE_SANDBOX_VOLUME_TYPE"] !== "snapshot") {
      throw new Error("Vercel sandbox supports snapshot persistence, not PVC")
    }
  }
  return {
    enabled: flag(env["OPENCODE_SANDBOX_ENABLED"]),
    provider,
    aliyun: aliyunKey && aliyunDomain && aliyunUrl ? {
      apiKey: aliyunKey, apiUrl: aliyunUrl, domain: aliyunDomain,
      template: env["OPENCODE_ALIYUN_TEMPLATE"]?.trim() || "code-interpreter-v1",
      pauseEnabled: flag(env["OPENCODE_ALIYUN_PAUSE_ENABLED"]),
      runnerAsset: env["OPENCODE_ALIYUN_RUNNER_ASSET"] || undefined,
      installRipgrep: env["OPENCODE_ALIYUN_INSTALL_RIPGREP"] === undefined ? true : flag(env["OPENCODE_ALIYUN_INSTALL_RIPGREP"]),
    } : undefined,
    vercel: token && teamId && projectId
      ? {
          token,
          teamId,
          projectId,
          image: env["OPENCODE_VERCEL_IMAGE"] || "vercel/sandbox/node:24",
          ...(env["OPENCODE_VERCEL_RUNNER_ASSET"] ? { runnerAsset: env["OPENCODE_VERCEL_RUNNER_ASSET"] } : {}),
          installRipgrep: env["OPENCODE_VERCEL_INSTALL_RIPGREP"] === undefined ? true : flag(env["OPENCODE_VERCEL_INSTALL_RIPGREP"]),
        }
      : undefined,
    domain: env["OPENCODE_SANDBOX_DOMAIN"] ?? "",
    protocol: env["OPENCODE_SANDBOX_PROTOCOL"] === "http" ? "http" : "https",
    apiKey: env["OPENCODE_SANDBOX_API_KEY"] || undefined,
    useServerProxy: flag(env["OPENCODE_SANDBOX_USE_SERVER_PROXY"]),
    // Unset defaults to true (gateway); an explicit value opts into/out of it.
    mcpServerProxy:
      env["OPENCODE_SANDBOX_MCP_SERVER_PROXY"] === undefined ? true : flag(env["OPENCODE_SANDBOX_MCP_SERVER_PROXY"]),
    image: env["OPENCODE_SANDBOX_IMAGE"] || DEFAULT_IMAGE,
    timeoutSeconds: number(env["OPENCODE_SANDBOX_TIMEOUT_SECONDS"], 600),
    maxTtlSeconds: number(env["OPENCODE_SANDBOX_MAX_TTL_SEC"], 3600),
    idleReapSeconds:
      env["OPENCODE_SANDBOX_IDLE_REAP_SEC"] === "0" ? 0 : number(env["OPENCODE_SANDBOX_IDLE_REAP_SEC"], 60 * 60),
    // 120s: remote control plane enforces its own synchronous create deadline
    // (observed 60s on the K8s backend), so budgets beyond that only cover the
    // local readiness wait; 120s aligns total create, SDK readyTimeout, and
    // (this + 60s) the create-lease window.
    createTimeoutSeconds: number(env["OPENCODE_SANDBOX_CREATE_TIMEOUT_SECONDS"], 120),
    filesTimeoutSeconds: integer(env["OPENCODE_SANDBOX_FILES_TIMEOUT_SECONDS"], 15),
    filesTimeoutRetries: nonNegativeInteger(env["OPENCODE_SANDBOX_FILES_TIMEOUT_RETRIES"], 1),
    resource: {
      cpu: env["OPENCODE_SANDBOX_CPU"] || "2",
      memory: env["OPENCODE_SANDBOX_MEMORY"] || "4Gi",
    },
    publicDomain: env["OPENCODE_SANDBOX_PUBLIC_DOMAIN"] || undefined,
    volumeType: provider !== "opensandbox" ? "snapshot" : volumeType(env["OPENCODE_SANDBOX_VOLUME_TYPE"]),
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
      // Best-effort scheduling only: this does not bound queue/commit latency
      // or guarantee completion before platform expiry.
      refreshSeconds:
        env["OPENCODE_SANDBOX_SNAPSHOT_REFRESH_SEC"] === "0"
          ? 0
          : Math.max(
              60,
              Math.min(
                number(env["OPENCODE_SANDBOX_SNAPSHOT_REFRESH_SEC"], 1800),
                Math.floor(number(env["OPENCODE_SANDBOX_TIMEOUT_SECONDS"], 600) / 3),
              ),
            ),
      prune: flag(env["OPENCODE_SANDBOX_SNAPSHOT_PRUNE"]),
    },
  }
}
