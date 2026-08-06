export async function apiRequest<T>(path: string, init?: RequestInit) {
  const response = await fetch(`/opencode${path}`, {
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(30_000),
    ...init,
  })
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}
