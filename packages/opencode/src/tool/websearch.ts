import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as Tool from "./tool"
import * as McpWebSearch from "./mcp-websearch"
import DESCRIPTION from "./websearch.txt"
import { checksum } from "@opencode-ai/core/util/encode"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Auth } from "@/auth"

export const Parameters = Schema.Struct({
  query: Schema.String.annotate({ description: "Websearch query" }),
  numResults: Schema.optional(Schema.Number).annotate({
    description: "Number of search results to return (default: 8)",
  }),
  livecrawl: Schema.optional(Schema.Literals(["fallback", "preferred"])).annotate({
    description:
      "Live crawl mode - 'fallback': use live crawling as backup if cached content unavailable, 'preferred': prioritize live crawling (default: 'fallback')",
  }),
  type: Schema.optional(Schema.Literals(["auto", "fast", "deep"])).annotate({
    description: "Search type - 'auto': balanced search (default), 'fast': quick results, 'deep': comprehensive search",
  }),
  contextMaxCharacters: Schema.optional(Schema.Number).annotate({
    description: "Maximum characters for context string optimized for LLMs (default: 10000)",
  }),
})

const WebSearchProviderSchema = Schema.Literals(["exa", "parallel", "zhipu"])
export type WebSearchProvider = Schema.Schema.Type<typeof WebSearchProviderSchema>

export function selectWebSearchProvider(
  sessionID: string,
  flags = { exa: false, parallel: false, zhipu: false },
): WebSearchProvider {
  const override = process.env.OPENCODE_WEBSEARCH_PROVIDER
  if (override === "exa" || override === "parallel" || override === "zhipu") return override
  if (flags.zhipu) return "zhipu"
  if (flags.parallel) return "parallel"
  if (flags.exa) return "exa"

  return Number.parseInt(checksum(sessionID) ?? "0", 36) % 2 === 0 ? "exa" : "parallel"
}

export function webSearchProviderLabel(provider: unknown) {
  if (provider === "parallel") return "Parallel Web Search"
  if (provider === "exa") return "Exa Web Search"
  if (provider === "zhipu") return "Zhipu Web Search"
  return "Web Search"
}

export function webSearchModelName(extra: Tool.Context["extra"]) {
  const model = extra?.model
  if (!model || typeof model !== "object") return undefined
  const api = "api" in model && model.api && typeof model.api === "object" ? model.api : undefined
  const apiID = api && "id" in api && typeof api.id === "string" ? api.id : undefined
  const id = "id" in model && typeof model.id === "string" ? model.id : undefined
  return (apiID ?? id)?.slice(0, 100)
}

function parallelAuthHeaders() {
  const headers = { "User-Agent": `opencode/${InstallationVersion}` }
  if (!process.env.PARALLEL_API_KEY) return headers
  return { ...headers, Authorization: `Bearer ${process.env.PARALLEL_API_KEY}` }
}

const ZHIPU_SEARCH_URL = "https://open.bigmodel.cn/api/paas/v4/web_search"

function callZhipu(
  http: HttpClient.HttpClient,
  apiKey: string,
  params: Schema.Schema.Type<typeof Parameters>,
) {
  return Effect.gen(function* () {
    const body = {
      search_engine: process.env.OPENCODE_ZHIPU_SEARCH_ENGINE || "search_std",
      search_query: params.query,
      count: params.numResults ?? 8,
    }
    const request = yield* HttpClientRequest.post(ZHIPU_SEARCH_URL).pipe(
      HttpClientRequest.setHeader("Content-Type", "application/json"),
      HttpClientRequest.setHeader("Authorization", `Bearer ${apiKey}`),
      HttpClientRequest.bodyJson(body),
    )
    const response = yield* HttpClient.filterStatusOk(http).execute(request).pipe(
      Effect.timeoutOrElse({
        duration: "25 seconds",
        orElse: () => Effect.die(new Error("zhipu web_search request timed out")),
      }),
    )
    const data = yield* response.json as unknown as Effect.Effect<ZhipuSearchResponse>
    const formatted = (data.search_result ?? [])
      .map(
        (r, i) =>
          `[${i + 1}] ${r.title}\n    ${r.link}\n    ${r.content ?? ""}${r.media ? ` (${r.media})` : ""}${r.publish_date ? ` [${r.publish_date}]` : ""}`,
      )
      .join("\n\n")
    return formatted || undefined
  })
}

interface ZhipuSearchResult {
  title: string
  link: string
  content?: string
  media?: string
  publish_date?: string
}

interface ZhipuSearchResponse {
  search_result?: ZhipuSearchResult[]
}

function callProvider(
  http: HttpClient.HttpClient,
  apiKey: string,
  provider: WebSearchProvider,
  params: Schema.Schema.Type<typeof Parameters>,
  ctx: Tool.Context,
) {
  if (provider === "zhipu") {
    return callZhipu(http, apiKey, params)
  }

  if (provider === "parallel") {
    return McpWebSearch.call(
      http,
      McpWebSearch.PARALLEL_URL,
      "web_search",
      McpWebSearch.ParallelSearchArgs,
      {
        objective: params.query,
        search_queries: [params.query],
        session_id: ctx.sessionID,
        model_name: webSearchModelName(ctx.extra),
      },
      "25 seconds",
      parallelAuthHeaders(),
    )
  }

  return McpWebSearch.call(
    http,
    McpWebSearch.EXA_URL,
    "web_search_exa",
    McpWebSearch.SearchArgs,
    {
      query: params.query,
      type: params.type || "auto",
      numResults: params.numResults || 8,
      livecrawl: params.livecrawl || "fallback",
      contextMaxCharacters: params.contextMaxCharacters,
    },
    "25 seconds",
  )
}

type Metadata = { provider: WebSearchProvider }

export const WebSearchTool = Tool.define(
  "websearch",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const flags = yield* RuntimeFlags.Service
    const auth = yield* Auth.Service

    const resolveZhipuApiKey = Effect.fnUntraced(function* () {
      const authInfo = yield* auth.get("zhipuai").pipe(Effect.orElseSucceed(() => undefined as any))
      if (authInfo && authInfo.type === "api") return authInfo.key as string
      return process.env.ZHIPU_API_KEY ?? ""
    })

    return {
      get description() {
        return DESCRIPTION.replace("{{year}}", new Date().getFullYear().toString())
      },
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const provider = selectWebSearchProvider(ctx.sessionID, {
            exa: flags.enableExa,
            parallel: flags.enableParallel,
            zhipu: flags.enableZhipu,
          })
          const title = webSearchProviderLabel(provider)
          yield* ctx.metadata({ title: `${title} "${params.query}"`, metadata: { provider } })

          yield* ctx.ask({
            permission: "websearch",
            patterns: [params.query],
            always: ["*"],
            metadata: {
              query: params.query,
              numResults: params.numResults,
              livecrawl: params.livecrawl,
              type: params.type,
              contextMaxCharacters: params.contextMaxCharacters,
              provider,
            },
          })

          const zhipuApiKey = provider === "zhipu" ? (yield* resolveZhipuApiKey()) : ""
          if (provider === "zhipu" && !zhipuApiKey) {
            return yield* Effect.die(
              new Error("Zhipu API key not found: set auth via PUT /auth/zhipuai or ZHIPU_API_KEY env"),
            )
          }

          const result = yield* callProvider(http, zhipuApiKey, provider, params, ctx)

          return {
            output: result ?? "No search results found. Please try a different query.",
            title: `${title}: ${params.query}`,
            metadata: { provider },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
