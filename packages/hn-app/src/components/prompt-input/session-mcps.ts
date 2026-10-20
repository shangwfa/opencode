export type SessionMcp = {
  name: string
  type?: string
  command?: string[]
  url?: string
  environment?: Record<string, string>
  headers?: Record<string, string>
  enabled?: boolean
  time_created?: string | number
  time_updated?: string | number
}

export type DisplaySessionMcp = {
  name: string
  type?: string
  description?: string
  status: "enabled" | "disabled"
  detail?: string
  session: SessionMcp
}

type FetchSessionMcpsInput = {
  baseUrl: string
  sessionId: string
  fetcher?: typeof fetch
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object"

const stringRecord = (value: unknown): Record<string, string> | undefined => {
  if (!isRecord(value)) return
  const out: Record<string, string> = {}
  for (const [key, val] of Object.entries(value)) {
    if (typeof val !== "string") return
    out[key] = val
  }
  return out
}

const stringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return
  const out = value.filter((item): item is string => typeof item === "string")
  return out.length === value.length ? out : undefined
}

export function normalizeSessionMcp(value: unknown): SessionMcp | undefined {
  if (!isRecord(value)) return
  const name = typeof value.name === "string" ? value.name.trim() : ""
  if (!name) return

  return {
    name,
    type: typeof value.type === "string" ? value.type : undefined,
    command: stringArray(value.command),
    url: typeof value.url === "string" ? value.url : undefined,
    environment: stringRecord(value.environment),
    headers: stringRecord(value.headers),
    enabled: typeof value.enabled === "boolean" ? value.enabled : undefined,
    time_created:
      typeof value.time_created === "string" || typeof value.time_created === "number" ? value.time_created : undefined,
    time_updated:
      typeof value.time_updated === "string" || typeof value.time_updated === "number" ? value.time_updated : undefined,
  }
}

// SDK 暂未暴露 session 级 MCP list，这里隔离 raw OpenCode endpoint，避免组件直接拼接路径。
export async function fetchSessionMcps(input: FetchSessionMcpsInput): Promise<SessionMcp[]> {
  const base = input.baseUrl.replace(/\/+$/, "")
  const sessionId = input.sessionId.trim()
  if (!base || !sessionId) return []

  const fetcher = input.fetcher ?? fetch
  const res = await fetcher(`${base}/session/${encodeURIComponent(sessionId)}/mcps`)
  if (!res.ok) throw new Error(`Failed to load session MCPs (${res.status})`)

  const data = await res.json()
  if (!Array.isArray(data)) return []
  return data.map(normalizeSessionMcp).filter((item): item is SessionMcp => !!item)
}

function sessionMcpDetail(mcp: SessionMcp): string | undefined {
  if (mcp.type === "remote" && mcp.url) return mcp.url
  if (mcp.type === "local" && mcp.command?.length) return mcp.command.join(" ")
  return mcp.type
}

export function toDisplaySessionMcps(
  sessionMcps: readonly SessionMcp[],
  descriptions: Readonly<Record<string, string | undefined>> = {},
): DisplaySessionMcp[] {
  const merged = new Map<string, DisplaySessionMcp>()
  for (const mcp of sessionMcps) {
    const name = mcp.name.trim()
    if (!name) continue
    const description = descriptions[name]?.trim() || undefined
    // session MCP 以当前会话显式挂载结果为准，同名项只展示最后一次返回的数据。
    merged.set(name, {
      name,
      type: mcp.type,
      ...(description ? { description } : {}),
      status: mcp.enabled === false ? "disabled" : "enabled",
      detail: sessionMcpDetail(mcp),
      session: mcp,
    })
  }

  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function countEnabledSessionMcps(items: readonly DisplaySessionMcp[]): number {
  return items.filter((item) => item.status === "enabled").length
}
