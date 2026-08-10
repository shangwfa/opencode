import { ConnectionConfig, Sandbox } from '@alibaba-group/opensandbox'
import type { Endpoint } from '@alibaba-group/opensandbox'
import type { ServerConfig } from './config.ts'

export interface SandboxInfo {
  id: string
  createdAt: string
  status: string
}

export interface SandboxEntry {
  sandbox: Sandbox
  info: SandboxInfo
  vncEndpoint: Endpoint
}
const activeSandboxes = new Map<string, SandboxEntry>()

export function createSandbox(config: ServerConfig): Promise<SandboxInfo> {
  const connectionConfig = new ConnectionConfig({
    domain: config.sandbox.domain,
    apiKey: config.sandbox.apiKey,
    protocol: config.sandbox.protocol,
    requestTimeoutSeconds: 60,
    useServerProxy: true,
  })

  return Sandbox.create({
    connectionConfig,
    image: config.sandbox.chromeImage,
    entrypoint: ['/cloud-browser-entrypoint.sh'],
    timeoutSeconds: 10 * 60,
    resource: { cpu: '1', memory: '2Gi' },
    metadata: { 'app.cloud-browser': 'true' },
  }).then(async (sandbox) => {
    console.log(`[sandbox] created: ${sandbox.id}`)
    const vncEndpoint = await sandbox.getEndpoint(6080)

    const info: SandboxInfo = {
      id: sandbox.id,
      createdAt: new Date().toISOString(),
      status: 'running',
    }

    activeSandboxes.set(sandbox.id, { sandbox, info, vncEndpoint })
    console.log(`[sandbox] ready: ${sandbox.id}, noVNC: ${vncEndpoint.endpoint}`)
    return info
  })
}

export async function destroySandbox(id: string): Promise<void> {
  const entry = activeSandboxes.get(id)
  if (!entry) throw new Error(`Sandbox ${id} not found`)
  await entry.sandbox.kill()
  await entry.sandbox.close()
  activeSandboxes.delete(id)
  console.log(`[sandbox] destroyed: ${id}`)
}

export function getSandbox(id: string): SandboxEntry | undefined {
  return activeSandboxes.get(id)
}

export function listSandboxes(): SandboxInfo[] {
  return Array.from(activeSandboxes.values()).map((entry) => entry.info)
}
