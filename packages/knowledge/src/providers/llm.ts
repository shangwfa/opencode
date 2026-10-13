/**
 * OpenAI 兼容 LLM / Embedding provider（可配置 baseURL + apiKey）。
 *
 * 保持与旧实现（mastra/providers/openai.ts）相同的调用形态：
 *   openaiChat(modelId)     → LanguageModel  供 generateText/streamText 使用
 *   openaiEmbedding(modelId)→ EmbeddingModel 供 embed/embedMany 使用
 */
import { createOpenAI } from "@ai-sdk/openai"
import { getChatEndpoint, getEmbeddingEndpoint, normalizeModelId } from "../config/env"
import { createInnerEmbeddingFetch, isInnerEmbeddingProxyEnabled } from "./inner-proxy"

const providerCache = new Map<string, ReturnType<typeof createOpenAI>>()

function getProvider(kind: "chat" | "embedding") {
  const endpoint = kind === "chat" ? getChatEndpoint() : getEmbeddingEndpoint()
  // embedding 可选走影刀内网代理（KNOWLEDGE_EMBEDDING_CHANNEL=inner，见 inner-proxy.ts）
  const innerEmbedding = kind === "embedding" && isInnerEmbeddingProxyEnabled()
  const cacheKey = `${kind}|${endpoint.baseURL}|${endpoint.apiKey}|${innerEmbedding ? "inner" : "std"}`
  let provider = providerCache.get(cacheKey)
  if (!provider) {
    provider = createOpenAI({
      baseURL: endpoint.baseURL,
      apiKey: endpoint.apiKey,
      ...(innerEmbedding ? { fetch: createInnerEmbeddingFetch() as unknown as typeof fetch } : {}),
    })
    providerCache.set(cacheKey, provider)
  }
  return provider
}

/** 清空 provider 缓存（测试或热更新配置时使用） */
export function resetLLMProviderCache(): void {
  providerCache.clear()
}

/** OpenAI 兼容 chat 模型 */
export function createChatModel(modelId: string) {
  return getProvider("chat").chat(normalizeModelId(modelId))
}

/** OpenAI 兼容 embedding 模型 */
export function createEmbeddingModel(modelId: string) {
  return getProvider("embedding").embedding(normalizeModelId(modelId))
}

/** 兼容旧调用形态的别名 */
export const openaiChat = createChatModel
export const openaiEmbedding = createEmbeddingModel
