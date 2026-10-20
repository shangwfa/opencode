import type { VcsFileDiff } from "@/types/opencode"

/** [MIGRATION] 源 ServerConnection.HttpBase 的最小面（url/password/username） */
export type ServerHttpBase = { url: string; password?: string; username?: string }

export type FetchVcsDiffOpts = {
  url: string
  directory: string
  mode: "git" | "branch"
  sessionID?: string
  fetch?: typeof fetch
  server?: ServerHttpBase
}

export async function fetchVcsDiff(opts: FetchVcsDiffOpts): Promise<VcsFileDiff[]> {
  const u = new URL("/vcs/diff", opts.url)
  u.searchParams.set("directory", opts.directory)
  u.searchParams.set("mode", opts.mode)
  if (opts.sessionID) u.searchParams.set("sessionID", opts.sessionID)

  const headers: Record<string, string> = {}
  if (opts.server?.password) {
    headers.Authorization = `Basic ${btoa(`${opts.server.username ?? "opencode"}:${opts.server.password}`)}`
  }

  const res = await (opts.fetch ?? fetch)(u, { headers })
  if (!res.ok) throw new Error(`Failed to load VCS diff: ${res.status}`)
  const data = await res.json()
  return Array.isArray(data) ? (data as VcsFileDiff[]) : []
}
