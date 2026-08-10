export interface ServerConfig {
  sandbox: {
    domain: string
    apiKey: string
    protocol: 'http' | 'https'
    windowsImage: string
  }
  saas: {
    baseUrl: string
    model: { providerID: string; modelID: string }
  }
  agent: {
    apiBase: string
  }
}

export function loadServerConfig(env: Record<string, string | undefined>): ServerConfig {
  const protocol = env.OPENCODE_SANDBOX_PROTOCOL ?? 'http'
  const modelRaw = env.OPENCODE_SAAS_MODEL ?? 'zhipuai/glm-5.1'
  const [providerID, modelID] = modelRaw.split('/')
  return {
    sandbox: {
      domain:
        env.OPENCODE_SANDBOX_DOMAIN ?? env.OPEN_SANDBOX_DOMAIN ?? 'localhost:8080',
      apiKey: env.OPENCODE_SANDBOX_API_KEY ?? env.OPEN_SANDBOX_API_KEY ?? '',
      protocol: protocol === 'https' ? 'https' : 'http',
      windowsImage: env.OPENCODE_WINDOWS_IMAGE ?? 'dockurr/windows:latest',
    },
    saas: {
      baseUrl: env.OPENCODE_SAAS_BASE_URL ?? 'http://localhost:14096',
      model: { providerID: providerID ?? 'zhipuai', modelID: modelID ?? 'glm-5.1' },
    },
    agent: {
      apiBase: env.CLOUD_WINDOWS_API_BASE ?? 'http://host.docker.internal:5173',
    },
  }
}
