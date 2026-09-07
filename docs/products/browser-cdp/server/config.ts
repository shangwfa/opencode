export interface ServerConfig {
  saasBaseUrl: string
  image: string
  cpu: string
  memory: string
  /** 直连 base（http://<沙箱IP>:9222）。缺省自动探测：docker inspect → endpoint directUrl → SaaS proxy */
  directBase: string
}

export function loadServerConfig(env: Record<string, string | undefined>): ServerConfig {
  return {
    saasBaseUrl: (env.OPENCODE_SAAS_BASE_URL ?? "http://localhost:14096").replace(/\/$/, ""),
    image: env.BROWSER_CDP_IMAGE ?? "opencode-saas-browser-cdp:test",
    cpu: env.BROWSER_CDP_CPU ?? "1",
    memory: env.BROWSER_CDP_MEMORY ?? "2Gi",
    directBase: (env.BROWSER_CDP_DIRECT_BASE ?? "").replace(/\/$/, ""),
  }
}
