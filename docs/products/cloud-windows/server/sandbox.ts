import { ConnectionConfig, Sandbox } from '@alibaba-group/opensandbox'
import type { Endpoint, PlatformSpec } from '@alibaba-group/opensandbox'
import type { ServerConfig } from './config.ts'
import { db } from './db.ts'

export interface SandboxInfo {
  id: string
  createdAt: string
  status: string
}

export interface SandboxEntry {
  sandbox: Sandbox
  info: SandboxInfo
  webEndpoint: Endpoint
}

const activeSandboxes = new Map<string, SandboxEntry>()

interface SandboxRow {
  id: string
  created_at: string
  status: string
}

const WINDOWS_PLATFORM: PlatformSpec = { os: 'windows', arch: 'amd64' }

function toConnectionConfig(config: ServerConfig): ConnectionConfig {
  return new ConnectionConfig({
    domain: config.sandbox.domain,
    apiKey: config.sandbox.apiKey,
    protocol: config.sandbox.protocol,
    requestTimeoutSeconds: 300,
    useServerProxy: true,
  })
}

export async function createSandbox(config: ServerConfig): Promise<SandboxInfo> {
  const sandbox = await Sandbox.create({
    connectionConfig: toConnectionConfig(config),
    image: config.sandbox.windowsImage,
    platform: WINDOWS_PLATFORM,
    timeoutSeconds: 60 * 60 * 12,
    readyTimeoutSeconds: 60 * 30,
    resource: { cpu: '4', memory: '8G', disk: '64G' },
    env: {
      VERSION: '11',
      USERNAME: 'Docker',
      PASSWORD: 'admin',
      LANGUAGE: 'Chinese',
      REGION: 'zh-CN',
      KEYBOARD: 'zh-CN',
    },
    metadata: { 'app.cloud-windows': 'true' },
  })

  console.log(`[sandbox] created: ${sandbox.id}`)
  const webEndpoint = await sandbox.getEndpoint(8006)

  const info: SandboxInfo = {
    id: sandbox.id,
    createdAt: new Date().toISOString(),
    status: 'running',
  }

  activeSandboxes.set(sandbox.id, { sandbox, info, webEndpoint })
  db.prepare(
    'INSERT INTO sandbox (id, created_at, status) VALUES (?, ?, ?)',
  ).run(info.id, info.createdAt, info.status)
  console.log(`[sandbox] ready: ${sandbox.id}, noVNC: ${webEndpoint.endpoint}`)
  return info
}

export async function destroySandbox(id: string): Promise<void> {
  const entry = activeSandboxes.get(id)
  if (entry) {
    await entry.sandbox.kill().catch(() => {})
    await entry.sandbox.close().catch(() => {})
    activeSandboxes.delete(id)
  }
  db.prepare("UPDATE sandbox SET status = 'destroyed' WHERE id = ?").run(id)
  console.log(`[sandbox] destroyed: ${id}`)
}

async function attachSandbox(
  config: ServerConfig,
  row: SandboxRow,
): Promise<SandboxEntry | undefined> {
  const cached = activeSandboxes.get(row.id)
  if (cached) return cached

  const sandbox = await Sandbox.connect({
    connectionConfig: toConnectionConfig(config),
    sandboxId: row.id,
    skipHealthCheck: true,
  })
  const healthy = await sandbox.isHealthy().catch(() => false)
  if (!healthy) {
    await sandbox.close().catch(() => {})
    throw new Error(`sandbox ${row.id} is not healthy (container gone)`)
  }
  const webEndpoint = await sandbox.getEndpoint(8006)
  const info: SandboxInfo = {
    id: row.id,
    createdAt: row.created_at,
    status: row.status,
  }
  const entry: SandboxEntry = { sandbox, info, webEndpoint }
  activeSandboxes.set(row.id, entry)
  return entry
}

export function getSandbox(id: string): SandboxEntry | undefined {
  return activeSandboxes.get(id)
}

export function resolveSandboxId(id: string): string {
  let current = id
  const seen = new Set<string>()
  while (seen.add(current)) {
    const row = db
      .prepare('SELECT new_id FROM sandbox_alias WHERE old_id = ?')
      .get(current) as { new_id: string } | undefined
    if (!row) return current
    current = row.new_id
  }
  return current
}

export function addSandboxAlias(oldId: string, newId: string): void {
  db.prepare('INSERT OR REPLACE INTO sandbox_alias (old_id, new_id) VALUES (?, ?)').run(
    oldId,
    newId,
  )
}

export async function requireSandbox(
  config: ServerConfig,
  id: string,
): Promise<SandboxEntry | undefined> {
  const resolvedId = resolveSandboxId(id)
  const cached = activeSandboxes.get(resolvedId)
  if (cached) return cached

  const row = db
    .prepare("SELECT * FROM sandbox WHERE id = ? AND status = 'running'")
    .get(resolvedId) as SandboxRow | undefined
  if (!row) return undefined

  try {
    return await attachSandbox(config, row)
  } catch (err) {
    console.warn(`[sandbox] reconnect failed: ${resolvedId}`, err)
    db.prepare("UPDATE sandbox SET status = 'lost' WHERE id = ?").run(resolvedId)
    return undefined
  }
}

export function listSandboxes(): SandboxInfo[] {
  const rows = db
    .prepare("SELECT * FROM sandbox WHERE status = 'running' ORDER BY created_at DESC")
    .all() as SandboxRow[]
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    status: row.status,
  }))
}
