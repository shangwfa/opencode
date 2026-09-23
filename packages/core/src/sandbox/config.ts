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
  /** Sandbox.create upper bound; first pulls of large images need headroom. */
  readonly createTimeoutSeconds: number
  /** CPU/memory request forwarded to the control plane. */
  readonly resource: { cpu: string; memory: string }
}

const DEFAULT_IMAGE = "registry.cn-hangzhou.aliyuncs.com/opensandbox/opencode-sandbox:latest"

const flag = (value: string | undefined) => value === "true" || value === "1"

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
    createTimeoutSeconds: number(env["OPENCODE_SANDBOX_CREATE_TIMEOUT_SECONDS"], 120),
    resource: {
      cpu: env["OPENCODE_SANDBOX_CPU"] || "2",
      memory: env["OPENCODE_SANDBOX_MEMORY"] || "4Gi",
    },
  }
}
