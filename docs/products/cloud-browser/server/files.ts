import type { ServerConfig } from './config.ts'
import { getAgent } from './agent.ts'

interface ExecResult {
  id: string
  exitCode: number
  stdout: string
  stderr: string
}

async function execCommand(
  config: ServerConfig,
  sessionId: string,
  command: string,
): Promise<ExecResult> {
  const res = await fetch(`${config.saas.baseUrl}/session/${sessionId}/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command }),
  })
  if (!res.ok) {
    throw new Error(`exec failed: HTTP ${res.status}`)
  }
  return (await res.json()) as ExecResult
}

export interface AgentFile {
  path: string
  name: string
  size: number
  modifiedAt: number
}

export async function listAgentFiles(
  config: ServerConfig,
  agentId: string,
): Promise<AgentFile[]> {
  const agent = getAgent(agentId)
  if (!agent) throw new Error(`Agent ${agentId} not found`)

  const result = await execCommand(
    config,
    agent.sessionId,
    `find /workspace -type f -not -path '*/.*' -printf '%P\\t%s\\t%T@\\n' 2>/dev/null | sort`,
  )
  return result.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [path, size, mtime] = line.split('\t')
      return {
        path: `/workspace/${path}`,
        name: path.split('/').pop() ?? path,
        size: Number(size) || 0,
        modifiedAt: Math.floor(Number(mtime) || 0) * 1000,
      }
    })
}

export async function readAgentFile(
  config: ServerConfig,
  agentId: string,
  filePath: string,
): Promise<{ contentBase64: string; size: number }> {
  const agent = getAgent(agentId)
  if (!agent) throw new Error(`Agent ${agentId} not found`)

  const normalized = filePath.startsWith('/workspace/')
    ? filePath
    : `/workspace/${filePath.replace(/^\/+/, '')}`
  if (normalized.includes('..')) throw new Error('invalid path')

  const result = await execCommand(
    config,
    agent.sessionId,
    `base64 -w0 -- '${normalized.replace(/'/g, "'\\''")}'`,
  )
  if (result.exitCode !== 0) {
    throw new Error(`read file failed: ${result.stdout.slice(0, 200)}`)
  }
  const contentBase64 = result.stdout.trim()
  return {
    contentBase64,
    size: Math.floor((contentBase64.length * 3) / 4),
  }
}
