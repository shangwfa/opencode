import { ConnectionConfig, Sandbox } from '@alibaba-group/opensandbox'
import type { Endpoint } from '@alibaba-group/opensandbox'
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
  vncEndpoint: Endpoint
  cdpEndpoint: Endpoint
}

const activeSandboxes = new Map<string, SandboxEntry>()

interface SandboxRow {
  id: string
  created_at: string
  status: string
}

function toConnectionConfig(config: ServerConfig): ConnectionConfig {
  return new ConnectionConfig({
    domain: config.sandbox.domain,
    apiKey: config.sandbox.apiKey,
    protocol: config.sandbox.protocol,
    requestTimeoutSeconds: 60,
    useServerProxy: true,
  })
}

export async function createSandbox(config: ServerConfig): Promise<SandboxInfo> {
  const sandbox = await Sandbox.create({
    connectionConfig: toConnectionConfig(config),
    image: config.sandbox.chromeImage,
    entrypoint: ['/cloud-browser-entrypoint.sh'],
    timeoutSeconds: 60 * 60,
    resource: { cpu: '1', memory: '2Gi' },
    metadata: { 'app.cloud-browser': 'true' },
  })

  console.log(`[sandbox] created: ${sandbox.id}`)
  const vncEndpoint = await sandbox.getEndpoint(6080)
  const cdpEndpoint = await sandbox.getEndpoint(9223)

  const info: SandboxInfo = {
    id: sandbox.id,
    createdAt: new Date().toISOString(),
    status: 'running',
  }

  activeSandboxes.set(sandbox.id, { sandbox, info, vncEndpoint, cdpEndpoint })
  db.prepare(
    'INSERT INTO sandbox (id, created_at, status) VALUES (?, ?, ?)',
  ).run(info.id, info.createdAt, info.status)
  console.log(`[sandbox] ready: ${sandbox.id}, noVNC: ${vncEndpoint.endpoint}`)
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
  const vncEndpoint = await sandbox.getEndpoint(6080)
  const cdpEndpoint = await sandbox.getEndpoint(9223)
  const info: SandboxInfo = {
    id: row.id,
    createdAt: row.created_at,
    status: row.status,
  }
  const entry: SandboxEntry = { sandbox, info, vncEndpoint, cdpEndpoint }
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
