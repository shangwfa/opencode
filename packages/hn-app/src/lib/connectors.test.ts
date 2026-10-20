import { describe, expect, test } from "vitest"
import {
  authLabel,
  categoryCounts,
  categoryName,
  configuredServices,
  connectableAuthTypes,
  connectorStats,
  filterProviders,
  isNoAuth,
  pickRecommended,
  providerIcon,
  type ConnectorConnection,
  type ConnectorProvider,
} from "./connectors"

const provider = (service: string, name: string, categories: string[], authTypes: string[]): ConnectorProvider => ({
  service,
  displayName: name,
  categories,
  authTypes,
})

const providers = [
  provider("github", "GitHub", ["Developer Tools"], ["oauth2"]),
  provider("gmail", "Gmail", ["Communication"], ["oauth2"]),
  provider("arxiv", "arXiv", ["AI"], ["no_auth"]),
  provider("airtable", "Airtable", ["Data", "Productivity"], ["oauth2", "api_key"]),
  provider("custom", "内部系统", ["Data"], ["custom_credential"]),
]

const connection = (service: string, status: ConnectorConnection["engineStatus"] = "active"): ConnectorConnection => ({
  id: `ccon_${service}`,
  service,
  alias: service,
  authType: "oauth2",
  status: "active",
  engineStatus: status,
  time: { created: 1, updated: 1 },
})

describe("connector catalog", () => {
  test("按名称、服务、描述和分类搜索", () => {
    expect(filterProviders(providers, { query: "github" }).map((item) => item.service)).toEqual(["github"])
    expect(filterProviders(providers, { query: "data" }).map((item) => item.service)).toEqual(["airtable", "custom"])
    expect(filterProviders(providers, { query: "内部" }).map((item) => item.service)).toEqual(["custom"])
    expect(filterProviders(providers, { query: "数据与存储" }).map((item) => item.service)).toEqual(["airtable", "custom"])
    expect(categoryName("Developer Tools")).toBe("开发与云服务")
  })

  test("分类筛选不区分大小写，空分类返回全部", () => {
    expect(filterProviders(providers, { category: "data" }).map((item) => item.service)).toEqual(["airtable", "custom"])
    expect(filterProviders(providers, { category: "  " })).toHaveLength(providers.length)
  })

  test("已配置优先排序并支持已配置/免配置筛选", () => {
    const configured = configuredServices([connection("custom")])
    const result = filterProviders(providers, { configured })
    expect(result[0].service).toBe("custom")
    expect(filterProviders(providers, { configured, scope: "configured" }).map((item) => item.service)).toEqual(["custom"])
    expect(filterProviders(providers, { scope: "no_auth" }).map((item) => item.service)).toEqual(["arxiv"])
  })

  test("连接与免配置统计", () => {
    expect(connectorStats(providers, [connection("github"), connection("gmail", "error")])).toEqual({
      providers: 5,
      categories: 5,
      noAuth: 1,
      connections: 2,
      active: 1,
    })
    expect(isNoAuth(providers[2])).toBe(true)
    expect(isNoAuth(providers[0])).toBe(false)
  })

  test("分类计数按数量倒序，缺失分类回退为空", () => {
    expect(categoryCounts(providers)).toEqual([
      { id: "Data", displayName: "Data", providerCount: 2 },
      { id: "AI", displayName: "AI", providerCount: 1 },
      { id: "Communication", displayName: "Communication", providerCount: 1 },
      { id: "Developer Tools", displayName: "Developer Tools", providerCount: 1 },
      { id: "Productivity", displayName: "Productivity", providerCount: 1 },
    ])
  })

  test("认证方式文案与可创建类型", () => {
    expect(authLabel(["oauth2", "api_key"])).toBe("OAuth · API Key")
    expect(authLabel(["no_auth"])).toBe("免配置")
    expect(connectableAuthTypes(providers[2])).toEqual([])
    expect(connectableAuthTypes(providers[3])).toEqual(["oauth2", "api_key"])
  })

  test("优先使用目录图标，否则按主页域名取 favicon", () => {
    expect(providerIcon({ iconUrl: "https://cdn.example.com/icon.png", homepageUrl: "https://x.dev" })).toBe("https://cdn.example.com/icon.png")
    expect(providerIcon({ homepageUrl: "https://www.github.com/features" })).toContain("domain=github.com")
    expect(providerIcon({ iconUrl: "file:///etc/passwd" })).toBeUndefined()
    expect(providerIcon({})).toBeUndefined()
  })

  test("推荐应用按固定优先级取交集，不足时回退目录", () => {
    expect(pickRecommended(providers, 2).map((item) => item.service)).toEqual(["gmail", "github"])
    const unrelated = [provider("foo", "Foo", ["Data"], ["api_key"])]
    expect(pickRecommended(unrelated, 2).map((item) => item.service)).toEqual(["foo"])
  })
})
