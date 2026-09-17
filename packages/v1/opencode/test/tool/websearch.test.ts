import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { parseResponse } from "../../src/tool/mcp-websearch"
import { selectWebSearchProvider, webSearchModelName, webSearchProviderLabel } from "../../src/tool/websearch"

import { webSearchEnabled } from "../../src/tool/registry"
import { it } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"

const SESSION_ID = "ses_0196aabbccddeeff001122334455"

describe("websearch provider", () => {
  test("selects a stable provider per session", () => {
    expect(selectWebSearchProvider(SESSION_ID)).toBe(selectWebSearchProvider(SESSION_ID))
  })

  test("supports an operational override", () => {
    const original = process.env.OPENCODE_WEBSEARCH_PROVIDER

    try {
      process.env.OPENCODE_WEBSEARCH_PROVIDER = "parallel"
      expect(selectWebSearchProvider(SESSION_ID)).toBe("parallel")

      process.env.OPENCODE_WEBSEARCH_PROVIDER = "exa"
      expect(selectWebSearchProvider(SESSION_ID)).toBe("exa")

      process.env.OPENCODE_WEBSEARCH_PROVIDER = "zhipu"
      expect(selectWebSearchProvider(SESSION_ID)).toBe("zhipu")
    } finally {
      if (original === undefined) delete process.env.OPENCODE_WEBSEARCH_PROVIDER
      else process.env.OPENCODE_WEBSEARCH_PROVIDER = original
    }
  })

  test("routes to Exa when the Exa flag is enabled", () => {
    expect(selectWebSearchProvider(SESSION_ID, { exa: true, parallel: false, zhipu: false })).toBe("exa")
  })

  test("routes to Parallel when the Parallel flag is enabled", () => {
    expect(selectWebSearchProvider(SESSION_ID, { exa: false, parallel: true, zhipu: false })).toBe("parallel")
  })

  test("routes to Zhipu when the Zhipu flag is enabled", () => {
    expect(selectWebSearchProvider(SESSION_ID, { exa: false, parallel: false, zhipu: true })).toBe("zhipu")
  })

  test("is only enabled for opencode, zhipu, opencode-go, or explicit websearch provider flags", () => {
    expect(webSearchEnabled(ProviderV2.ID.opencode, { exa: false, parallel: false, zhipu: false })).toBe(true)
    expect(webSearchEnabled(ProviderV2.ID.make("opencode-go"), { exa: false, parallel: false, zhipu: false })).toBe(
      true,
    )
    expect(webSearchEnabled(ProviderV2.ID.openai, { exa: false, parallel: false, zhipu: false })).toBe(false)
    expect(webSearchEnabled(ProviderV2.ID.openai, { exa: true, parallel: false, zhipu: false })).toBe(true)
    expect(webSearchEnabled(ProviderV2.ID.openai, { exa: false, parallel: true, zhipu: false })).toBe(true)
    expect(webSearchEnabled(ProviderV2.ID.make("zhipuai"), { exa: false, parallel: false, zhipu: false })).toBe(true)
  })

  test("uses branded labels", () => {
    expect(webSearchProviderLabel("parallel")).toBe("Parallel Web Search")
    expect(webSearchProviderLabel("exa")).toBe("Exa Web Search")
    expect(webSearchProviderLabel("zhipu")).toBe("Zhipu Web Search")
    expect(webSearchProviderLabel(undefined)).toBe("Web Search")
  })

  test("uses the provider API model id for Parallel analytics", () => {
    expect(
      webSearchModelName({
        model: {
          id: "claude-opus-4-7",
          api: { id: "claude-opus-4.7" },
        },
      }),
    ).toBe("claude-opus-4.7")
  })
})

describe("websearch MCP response parser", () => {
  const payload = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [
        {
          type: "text",
          text: "search results",
        },
      ],
    },
  })

  it.effect("parses plain JSON-RPC responses", () =>
    Effect.gen(function* () {
      const result = yield* parseResponse(payload)
      expect(result).toBe("search results")
    }),
  )

  it.effect("parses SSE JSON-RPC responses", () =>
    Effect.gen(function* () {
      const result = yield* parseResponse(`event: message\ndata: ${payload}\n\n`)
      expect(result).toBe("search results")
    }),
  )

  it.effect("ignores non-JSON SSE data frames", () =>
    Effect.gen(function* () {
      const result = yield* parseResponse(`data: [DONE]\ndata: ${payload}\n\n`)
      expect(result).toBe("search results")
    }),
  )
})
