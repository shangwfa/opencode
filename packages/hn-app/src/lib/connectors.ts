import catalog from "./connector-catalog.json"

export type ConnectorProvider = {
  service: string
  displayName: string
  description?: string
  categories: string[]
  authTypes: string[]
  homepageUrl?: string
  iconUrl?: string
}

export type ConnectorCategory = { id: string; displayName: string; providerCount: number }

export type ConnectorAction = {
  id: string
  service: string
  name: string
  description?: string
  operationType: "read" | "write" | "destructive" | string
  requiredScopes?: string[]
  providerPermissions?: string[]
}

export type ConnectorAuthOption = {
  id: string
  label: string
  description?: string
  required?: boolean
  defaultSelected?: boolean
  risk?: "standard" | "sensitive" | "destructive" | string
}

export type ConnectorAuth = {
  type: "oauth2" | "api_key" | "custom_credential"
  authorizationOptions?: ConnectorAuthOption[]
}

export type ConnectorProviderDetail = ConnectorProvider & {
  auth?: ConnectorAuth[]
  actions: ConnectorAction[]
  triggers?: unknown[]
}

export type ConnectorConnection = {
  id: string
  service: string
  alias: string
  authType: "api_key" | "custom_credential" | "oauth2"
  status: "creating" | "active" | "deleting" | "deleted"
  engineStatus: string
  accountLabel?: string
  time: { created: number; updated: number }
}

export type ConnectorScope = "all" | "configured" | "no_auth"

export type ConnectorMcpDeployment = {
  id: string; name: string; service: string; connectionId: string | null; status: string; revision: number
  tools: Array<{ actionId: string; name: string; contractHash: string }>
  tokenPrefix: string; timeCreated: number; timeUpdated: number
}
export type ConnectorMcpIssued = { deployment: ConnectorMcpDeployment; token: string }

/** 内置目录快照：Connector 服务未启用时仍可浏览；连接操作始终走实时服务。 */
export const fallbackProviders = (catalog as { providers: ConnectorProvider[] }).providers

export const recommendedServices = ["shopify_admin", "gmail", "github", "notion", "slack", "airtable"]

export function isNoAuth(provider: ConnectorProvider): boolean {
  return provider.authTypes.includes("no_auth")
}

export function authLabel(authTypes: readonly string[]): string {
  const labels: string[] = []
  if (authTypes.includes("oauth2")) labels.push("OAuth")
  if (authTypes.includes("api_key")) labels.push("API Key")
  if (authTypes.includes("custom_credential")) labels.push("自定义凭据")
  if (authTypes.includes("no_auth")) labels.push("免配置")
  return labels.join(" · ") || "未标注"
}

/** 可创建的认证方式；no_auth 不需要连接记录。 */
export function connectableAuthTypes(provider: ConnectorProvider): Array<"api_key" | "custom_credential" | "oauth2"> {
  return provider.authTypes.filter(
    (item): item is "api_key" | "custom_credential" | "oauth2" =>
      item === "api_key" || item === "custom_credential" || item === "oauth2",
  )
}

export function configuredServices(connections: readonly ConnectorConnection[]): Set<string> {
  return new Set(connections.filter((item) => item.status !== "deleted").map((item) => item.service))
}

export function filterProviders(
  providers: readonly ConnectorProvider[],
  input: { query?: string; category?: string; scope?: ConnectorScope; configured?: ReadonlySet<string> },
): ConnectorProvider[] {
  const query = input.query?.trim().toLocaleLowerCase()
  const category = input.category?.trim().toLocaleLowerCase()
  const configured = input.configured ?? new Set<string>()
  return providers
    .filter((provider) => {
      if (category && !provider.categories.some((item) => item.toLocaleLowerCase() === category)) return false
      if (input.scope === "configured" && !configured.has(provider.service)) return false
      if (input.scope === "no_auth" && !isNoAuth(provider)) return false
      if (!query) return true
      return [provider.displayName, provider.service, provider.description ?? "", ...provider.categories, ...provider.categories.map(categoryName)]
        .join(" ")
        .toLocaleLowerCase()
        .includes(query)
    })
    .toSorted((a, b) => Number(configured.has(b.service)) - Number(configured.has(a.service)) || a.displayName.localeCompare(b.displayName))
}

export function categoryCounts(providers: readonly ConnectorProvider[]): ConnectorCategory[] {
  const counts = new Map<string, number>()
  for (const provider of providers) {
    for (const category of provider.categories) counts.set(category, (counts.get(category) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([id, providerCount]) => ({ id, displayName: id, providerCount }))
    .sort((a, b) => b.providerCount - a.providerCount || a.id.localeCompare(b.id))
}

export function connectorStats(providers: readonly ConnectorProvider[], connections: readonly ConnectorConnection[]) {
  return {
    providers: providers.length,
    categories: categoryCounts(providers).length,
    noAuth: providers.filter(isNoAuth).length,
    connections: connections.filter((item) => item.status !== "deleted").length,
    active: connections.filter((item) => item.engineStatus === "active").length,
  }
}

export function pickRecommended(providers: readonly ConnectorProvider[], limit = 4): ConnectorProvider[] {
  const byService = new Map(providers.map((provider) => [provider.service, provider]))
  const picked = recommendedServices.flatMap((service) => byService.get(service) ?? [])
  return (picked.length ? picked : providers).slice(0, limit)
}

const categoryNames: Record<string, string> = {
  Data: "数据与存储",
  Productivity: "项目与效率",
  "Developer Tools": "开发与云服务",
  Marketing: "营销增长",
  Communication: "协作与知识",
  AI: "AI 与 Agent",
  Finance: "投资与交易",
  "Design & Media": "设计与媒体",
  Security: "安全与合规",
  Location: "位置与物流",
  Social: "社交",
  Storage: "存储",
  "Data & Analytics": "数据分析",
  Infrastructure: "基础设施",
  Design: "设计",
  "E-commerce": "电商",
  Documents: "文档",
  "Documents & Content": "文档与内容",
  Media: "媒体",
  Analytics: "分析",
}

export function categoryName(category: string): string {
  return categoryNames[category] ?? category
}

export function categoryLabel(provider: ConnectorProvider): string {
  return categoryName(provider.categories[0] ?? "其他")
}

/** Prefer the catalog icon; fall back to the provider homepage favicon. */
export function providerIcon(provider: Pick<ConnectorProvider, "iconUrl" | "homepageUrl">): string | undefined {
  if (provider.iconUrl) {
    try {
      const url = new URL(provider.iconUrl)
      if (url.protocol === "http:" || url.protocol === "https:") return url.toString()
    } catch {}
  }
  if (!provider.homepageUrl) return undefined
  try {
    const host = new URL(provider.homepageUrl).hostname.replace(/^www\./, "")
    return host ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64` : undefined
  } catch {
    return undefined
  }
}
