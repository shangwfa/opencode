/**
 * Provider/模型列表（GET /provider），模块级缓存 + 状态订阅。
 * 归一化对齐源 normalizeProviderList：过滤 deprecated 模型。
 */
import { useEffect, useState } from "react"
import { providerList } from "@/lib/rest"
import { baseFetch } from "@/lib/base-api"
import { usingBaseServer } from "@/lib/session-source"

export type ProviderModelInfo = {
  id?: string
  name?: string
  providerID?: string
  status?: string
  limit?: {
    context?: number
    [key: string]: unknown
  }
  [key: string]: unknown
}

export type NormalizedProvider = {
  id: string
  name?: string
  models: Record<string, ProviderModelInfo>
}

export type NormalizedProviderList = {
  connected?: string[]
  all: NormalizedProvider[]
}

let cache: NormalizedProviderList | null = null
let inflight: Promise<NormalizedProviderList> | null = null
const listeners = new Set<(v: NormalizedProviderList | null) => void>()

function normalize(input: unknown): NormalizedProviderList {
  const root = (input ?? {}) as {
    connected?: string[]
    all?: { id: string; name?: string; models?: Record<string, ProviderModelInfo> }[]
  }
  const all: NormalizedProvider[] = (root.all ?? []).map((provider) => ({
    id: provider.id,
    name: provider.name,
    models: Object.fromEntries(
      Object.entries(provider.models ?? {}).filter(([, info]) => info.status !== "deprecated"),
    ),
  }))
  return { connected: root.connected ?? [], all }
}

export async function fetchProviderList(force = false): Promise<NormalizedProviderList> {
  if (!force && cache) return cache
  if (inflight) return inflight
  const load = usingBaseServer()
    ? baseFetch<{ data: (ProviderModelInfo & { id: string; providerID: string })[] }>("/api/models").then(({ data }) => {
        const all: NormalizedProvider[] = []
        for (const model of data) {
          let provider = all.find((item) => item.id === model.providerID)
          if (!provider) { provider = { id: model.providerID, name: model.providerID, models: {} }; all.push(provider) }
          provider.models[model.id] = model
        }
        return { all, connected: all.map((item) => item.id) }
      })
    : providerList()
  inflight = load
    .then((raw) => {
      cache = normalize(raw)
      listeners.forEach((l) => l(cache))
      return cache
    })
    .catch(() => {
      const empty: NormalizedProviderList = { connected: [], all: [] }
      cache = empty
      listeners.forEach((l) => l(cache))
      return empty
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

/** React 订阅入口（挂载即拉取，带模块级缓存） */
export function useProviderList(): {
  providers: NormalizedProviderList | null
  reload: () => void
} {
  const [providers, setProviders] = useState<NormalizedProviderList | null>(cache)

  useEffect(() => {
    const listener = (v: NormalizedProviderList | null) => setProviders(v)
    listeners.add(listener)
    void fetchProviderList()
    return () => {
      listeners.delete(listener)
    }
  }, [])

  const reload = () => {
    void fetchProviderList(true)
  }

  return { providers, reload }
}

/**
 * 免费判定（1:1 对齐源 dialog-select-model-unpaid.tsx:62）：
 * `provider.id === "opencode" && (!model.cost || model.cost.input === 0)`
 * 注意：其它 provider 的 0 成本不代表用户可免费使用（走各自计费/连接），因此不计入。
 */
export function isFreeModel(provider: NormalizedProvider, model: ProviderModelInfo): boolean {
  if (provider.id !== "opencode") return false
  const cost = model.cost as { input?: number } | undefined
  if (!cost) return true
  return cost.input === 0
}

/** 下拉展示用模型（对齐源 list：去掉 "(latest)" 后缀 + latest 标记） */
export type DisplayModel = ProviderModelInfo & {
  displayName: string
  latest: boolean
  free: boolean
}

export type AvailableGroup = {
  provider: NormalizedProvider
  models: DisplayModel[]
  connected: boolean
}

/** 展示名：源 models.tsx list() 的 name.replace("(latest)", "").trim() */
export function toDisplayModel(provider: NormalizedProvider, model: ProviderModelInfo): DisplayModel {
  const raw = typeof model.name === "string" ? model.name : ((model.id as string) ?? "")
  return {
    ...model,
    displayName: raw.replace("(latest)", "").trim(),
    latest: raw.includes("(latest)"),
    free: isFreeModel(provider, model),
  }
}

/**
 * 模型可见性（对齐原项目 models.tsx visible()）：
 * - 用户覆盖略；默认：无 release_date → 可见
 * - 按 (family) 分组取 release_date 最新，且距今 ≤ 6 个月 → 该组最新模型可见
 * - release_date 超过 6 个月的旧版本 → 隐藏
 */
function applyVisibility(models: ProviderModelInfo[]): ProviderModelInfo[] {
  const SIX_MONTHS_MS = 182 * 24 * 3600 * 1000
  const parseDate = (m: ProviderModelInfo): number | null => {
    const raw = m.release_date
    if (!raw || typeof raw !== "string") return null
    const t = Date.parse(raw)
    return Number.isNaN(t) ? null : t
  }
  // per family 最新
  const latestByFamily = new Map<string, { model: ProviderModelInfo; date: number }>()
  for (const m of models) {
    const date = parseDate(m)
    if (date === null) continue
    const family = (m.family as string) || (m.id as string)
    const cur = latestByFamily.get(family)
    if (!cur || date > cur.date) latestByFamily.set(family, { model: m, date })
  }
  const latestKeys = new Set(
    [...latestByFamily.values()]
      .filter(({ date }) => Math.abs(Date.now() - date) < SIX_MONTHS_MS)
      .map(({ model }) => model.id as string),
  )
  return models.filter((m) => {
    const date = parseDate(m)
    if (date === null) return true // 无发布时间 → 默认可见
    return latestKeys.has(m.id as string)
  })
}

/**
 * 可用模型分组（1:1 对齐源 models.tsx available + visible()）：
 * - 已连接 provider：全部模型，再按 visible() 收敛（无 release_date → 显示；
 *   6 个月内 per (provider, family) 最新 → 显示；更旧的版本 → 隐藏）
 * - 未连接的 opencode provider：仅免费模型（同样走 visible()），即「免费可用模型」
 * - 其它未连接 provider：不显示（需用户自行连接，属 provider 管理面职责）
 */
export function selectAvailableModels(providers: NormalizedProviderList | null): AvailableGroup[] {
  const connected = providers?.connected ?? []
  const groups: AvailableGroup[] = []
  const freeGroups: AvailableGroup[] = []
  for (const provider of providers?.all ?? []) {
    const isConnected = connected.includes(provider.id)
    if (!isConnected && provider.id !== "opencode") continue
    const models = Object.values(provider.models ?? {})
    const filtered = isConnected
      ? applyVisibility(models)
      : applyVisibility(models.filter((m) => isFreeModel(provider, m)))
    if (filtered.length === 0) continue
    // 已连接（可用）在上，OpenCode 免费模型在下 —— 对齐源 unpaid 弹窗的分区顺序
    const group = {
      provider,
      models: filtered.map((m) => toDisplayModel(provider, m)),
      connected: isConnected,
    }
    if (isConnected) groups.push(group)
    else freeGroups.push(group)
  }
  return [...groups, ...freeGroups]
}

/** 选第一个已连接 provider 的第一个可用模型（源 pickModel 语义）；无连接时回退第一个免费模型 */
export function pickFirstModel(providers: NormalizedProviderList | null): { providerID: string; modelID: string } | undefined {
  const groups = selectAvailableModels(providers)
  const first = groups[0]
  const model = first?.models[0]
  if (!first || !model) return undefined
  return { providerID: first.provider.id, modelID: (model.id as string) ?? "" }
}
