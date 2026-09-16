import { describe, expect, test } from "bun:test"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Provider } from "@/provider/provider"
import type { Provider as ProviderTypes } from "@/provider/provider"

const makeProvider = (overrides: Partial<ProviderTypes.Info> = {}): ProviderTypes.Info => ({
  id: ProviderV2.ID.make("test-provider"),
  name: "Test Provider",
  source: "api",
  env: [],
  key: "sk-secret-provider-key",
  options: { apiKey: "sk-secret-option-key", baseURL: "https://example.com" },
  models: {},
  ...overrides,
})

describe("Provider.toPublicInfo", () => {
  test("strips the provider key", () => {
    const result = Provider.toPublicInfo(makeProvider())
    expect(result.key).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain("sk-secret-provider-key")
  })

  test("strips apiKey from provider options but keeps other options", () => {
    const result = Provider.toPublicInfo(makeProvider())
    expect(result.options.apiKey).toBeUndefined()
    expect(result.options.baseURL).toBe("https://example.com")
    expect(JSON.stringify(result)).not.toContain("sk-secret-option-key")
  })

  test("keeps provider identity fields", () => {
    const result = Provider.toPublicInfo(makeProvider())
    expect(String(result.id)).toBe("test-provider")
    expect(result.name).toBe("Test Provider")
    expect(result.source).toBe("api")
  })

  test("drops function values from options", () => {
    const result = Provider.toPublicInfo(
      makeProvider({
        options: { fetch: (() => {}) as unknown as string, apiKey: "sk-secret", baseURL: "https://example.com" },
      }),
    )
    expect("fetch" in result.options).toBe(false)
    expect(result.options.apiKey).toBeUndefined()
    expect(result.options.baseURL).toBe("https://example.com")
  })

  test("sanitizes nested model options containing api keys", () => {
    const provider = makeProvider({
      options: {
        apiKey: "sk-secret",
        headers: { "x-api-key": "sk-nested-secret" },
        baseURL: "https://example.com",
      },
    })
    const result = Provider.toPublicInfo(provider)
    const raw = JSON.stringify(result)
    expect(raw).not.toContain("sk-secret")
    expect(raw).not.toContain("sk-nested-secret")
  })

  test("strips token and authorization shapes at any depth", () => {
    const provider = makeProvider({
      options: {
        token: "tok-value",
        access_token: "tok-access",
        refresh_token: "tok-refresh",
        authorization: "Bearer tok-bearer",
        nested: { password: "pw-value", secret: "sec-value", keep: "visible" },
      },
    })
    const raw = JSON.stringify(Provider.toPublicInfo(provider))
    expect(raw).not.toContain("tok-value")
    expect(raw).not.toContain("tok-access")
    expect(raw).not.toContain("tok-refresh")
    expect(raw).not.toContain("tok-bearer")
    expect(raw).not.toContain("pw-value")
    expect(raw).not.toContain("sec-value")
    expect(raw).toContain("visible")
  })

  test("keeps non-credential fields that merely contain key-ish substrings", () => {
    const provider = makeProvider({
      options: { hotkey: "ctrl-k", keyword: "opencode", maxTokens: 4096, apiKey: "sk-hidden" },
    })
    const result = Provider.toPublicInfo(provider)
    expect(result.options.hotkey).toBe("ctrl-k")
    expect(result.options.keyword).toBe("opencode")
    expect(result.options.maxTokens).toBe(4096)
    expect(result.options.apiKey).toBeUndefined()
  })
})
