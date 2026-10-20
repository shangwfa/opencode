export type TokenBreakdown = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  total: number
}

export type SessionUsageResponse = {
  id: string
  cost?: number
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: {
      read?: number
      write?: number
    }
  }
  model?: {
    id?: string
    providerID?: string
  }
}

export type ProviderListLike = {
  all?: ProviderLike[]
}

export type ProviderLike = {
  id: string
  name?: string
  models?: Record<string, ModelLike | undefined>
}

export type ModelLike = {
  id?: string
  name?: string
  providerID?: string
  limit?: {
    context?: number
  }
}

export function tokenBreakdownFromSession(session: SessionUsageResponse | undefined): TokenBreakdown | undefined {
  const tokens = session?.tokens
  if (!tokens) return undefined

  // `/session/:id` returns cumulative session tokens, which are useful for total
  // consumption but should not be treated as current context pressure.
  const input = tokens.input ?? 0
  const output = tokens.output ?? 0
  const reasoning = tokens.reasoning ?? 0
  const cacheRead = tokens.cache?.read ?? 0
  const cacheWrite = tokens.cache?.write ?? 0

  return {
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
    total: input + output + reasoning + cacheRead + cacheWrite,
  }
}

export function findProviderModel(
  modelRef: SessionUsageResponse["model"] | undefined,
  providers: ProviderLike[] = [],
) {
  // Match the exact model used by the session before reading `limit.context`.
  // Many providers expose similarly named models, so fuzzy matching would be misleading.
  const provider = providers.find((item) => item.id === modelRef?.providerID)
  const model = modelRef?.id ? provider?.models?.[modelRef.id] : undefined

  return {
    provider,
    model,
    providerLabel: provider?.name ?? modelRef?.providerID,
    modelLabel: model?.name ?? modelRef?.id,
    limit: model?.limit?.context,
  }
}

export function usagePercent(total: number | undefined, limit: number | undefined) {
  if (!total || !limit) return null
  return Math.round((total / limit) * 100)
}
