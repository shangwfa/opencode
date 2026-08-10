export interface ServerConfig {
  sandbox: {
    domain: string
    apiKey: string
    protocol: 'http' | 'https'
    chromeImage: string
  }
}

export function loadServerConfig(env: Record<string, string | undefined>): ServerConfig {
  const protocol = env.OPENCODE_SANDBOX_PROTOCOL ?? 'http'
  return {
    sandbox: {
      domain:
        env.OPENCODE_SANDBOX_DOMAIN ?? env.OPEN_SANDBOX_DOMAIN ?? 'localhost:8080',
      apiKey: env.OPENCODE_SANDBOX_API_KEY ?? env.OPEN_SANDBOX_API_KEY ?? '',
      protocol: protocol === 'https' ? 'https' : 'http',
      chromeImage: env.OPENCODE_CHROME_IMAGE ?? 'cloud-browser/chrome-novnc:latest',
    },
  }
}
