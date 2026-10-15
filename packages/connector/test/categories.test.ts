import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { ConnectorConnection } from "@opencode/schema/connector-connection"
import { Connector } from "@opencode/connector/adapter/connector"
import type { ConnectorEngine } from "@opencode/connector/adapter/engine"
import { collectCategories, filterByCategory, matchesCategory } from "@opencode/connector/categories"

describe("collectCategories", () => {
  it("aggregates labels with provider counts and sorts alphabetically", () => {
    const categories = collectCategories([
      { categories: ["Productivity", "Data"] },
      { categories: ["Data"] },
      { categories: ["AI"] },
    ])
    expect(categories).toEqual([
      { id: "AI", displayName: "AI", providerCount: 1 },
      { id: "Data", displayName: "Data", providerCount: 2 },
      { id: "Productivity", displayName: "Productivity", providerCount: 1 },
    ])
  })

  it("deduplicates case-insensitively and keeps the first-seen casing", () => {
    const categories = collectCategories([
      { categories: ["Developer Tools"] },
      { categories: ["developer tools"] },
      { categories: ["DEVELOPER TOOLS"] },
    ])
    expect(categories).toHaveLength(1)
    expect(categories[0]).toEqual({ id: "Developer Tools", displayName: "Developer Tools", providerCount: 3 })
  })

  it("drops empty labels and handles providers without categories", () => {
    const categories = collectCategories([{ categories: ["", "  ", "Security"] }, { categories: [] }, {} as { categories: ReadonlyArray<string> }])
    expect(categories).toEqual([{ id: "Security", displayName: "Security", providerCount: 1 }])
  })

  it("returns an empty taxonomy for an empty provider list", () => {
    expect(collectCategories([])).toEqual([])
  })
})

describe("matchesCategory / filterByCategory", () => {
  it("matches case-insensitively and tolerates surrounding whitespace", () => {
    expect(matchesCategory({ categories: ["Developer Tools"] }, "  developer tools ")).toBe(true)
    expect(matchesCategory({ categories: ["Developer Tools"] }, "Data")).toBe(false)
  })

  it("treats a blank category as matching everything", () => {
    expect(matchesCategory({ categories: ["Data"] }, "")).toBe(true)
    expect(matchesCategory({ categories: ["Data"] }, "   ")).toBe(true)
  })

  it("filters providers by category and passes everything through for a blank filter", () => {
    const providers = [{ categories: ["Data"] }, { categories: ["AI"] }, { categories: ["Data", "AI"] }]
    expect(filterByCategory(providers, "data")).toEqual([providers[0], providers[2]])
    expect(filterByCategory(providers, undefined)).toEqual(providers)
    expect(filterByCategory(providers, " ")).toEqual(providers)
    expect(filterByCategory(providers, "Finance")).toEqual([])
  })
})

const providerEntry = (service: string, categories: string[]) => ({
  service,
  displayName: service,
  categories,
  authTypes: ["api_key"],
})

const makeEngine = (providers: unknown[]): ConnectorEngine.Interface =>
  ({
    providers: () => Effect.succeed(providers),
  }) as unknown as ConnectorEngine.Interface

const makeStore = () =>
  ({
    resolveOwner: (sessionID: string) => Effect.succeed(sessionID),
    insert: () => Effect.void,
    listBySession: () => Effect.succeed([]),
    delete: () => Effect.void,
    deleteBySession: () => Effect.void,
    listAllEngineConnectionIds: () => Effect.succeed([]),
    insertOAuthRequest: () => Effect.succeed(false),
    updateOAuthRequestState: () => Effect.void,
    listOAuthRequestsBySession: () => Effect.succeed([]),
  }) as unknown as Connector.StoreInterface

const service = (providers: unknown[]) =>
  Connector.make(makeStore(), makeStore() as never, makeEngine(providers), {
    mcpName: "connector",
    mcpUrl: undefined,
    webhookUrl: undefined,
    fileUrlBase: undefined,
  })

describe("Connector.categories", () => {
  it("returns the aggregated taxonomy from the engine provider directory", async () => {
    const catalog = await Effect.runPromise(
      service([
        providerEntry("github", ["Developer Tools"]),
        providerEntry("attio", ["Productivity", "Data"]),
        providerEntry("gptzero", ["AI", "data"]),
        providerEntry("broken", null as never),
      ]).categories(),
    )
    expect(catalog.categories).toEqual([
      { id: "AI", displayName: "AI", providerCount: 1 },
      { id: "Data", displayName: "Data", providerCount: 2 },
      { id: "Developer Tools", displayName: "Developer Tools", providerCount: 1 },
      { id: "Productivity", displayName: "Productivity", providerCount: 1 },
    ])
  })

  it("skips entries the provider contract rejects", async () => {
    const catalog = await Effect.runPromise(service([{ service: "no-categories" }, 42]).categories())
    expect(catalog.categories).toEqual([])
  })
})

describe("Connector.catalog category filter", () => {
  const providers = [
    providerEntry("github", ["Developer Tools"]),
    providerEntry("attio", ["Productivity", "Data"]),
    providerEntry("gptzero", ["AI", "Data"]),
  ]

  it("narrows the directory by category case-insensitively", async () => {
    const catalog = await Effect.runPromise(service(providers).catalog({ category: "data" }))
    expect(catalog.providers.map((provider) => provider.service)).toEqual(["attio", "gptzero"])
  })

  it("combines category with the existing service filter", async () => {
    const catalog = await Effect.runPromise(service(providers).catalog({ category: "Data", service: "gptzero" }))
    expect(catalog.providers.map((provider) => provider.service)).toEqual(["gptzero"])
  })

  it("keeps the full directory when no category is given", async () => {
    const catalog = await Effect.runPromise(service(providers).catalog())
    expect(catalog.providers).toHaveLength(3)
    const empty = await Effect.runPromise(service(providers).catalog({ category: "" }))
    expect(empty.providers).toHaveLength(3)
  })
})

it("exposes categories through the schema contract", () => {
  const catalog = ConnectorConnection.CategoryCatalog.make({
    categories: [{ id: "Data", displayName: "Data", providerCount: 2 }],
  })
  expect(catalog.categories[0]!.providerCount).toBe(2)
})
