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
import { createConversationProxyFetch, isConversationProxyEnabled, resolveChannelModel, type OpenAICompatibleChannel } from "./conversation-proxy"

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

/** 内网会话代理 chat provider：按渠道路由（鉴权由 xybot-user header 接管，apiKey 占位）。 */function getInnerChatProvider(channel: OpenAICompatibleChannel) {
  const cacheKey = `chat|inner|${channel}`
  let provider = providerCache.get(cacheKey)
  if (!provider) {
    provider = createOpenAI({
      apiKey: 'unused',
      fetch: createConversationProxyFetch(channel) as unknown as typeof fetch,
    })
    providerCache.set(cacheKey, provider)
  }
  return provider
}

/** 清空 provider 缓存（测试或热更新配置时使用） */
export function resetLLMProviderCache(): void {
  providerCache.clear()
}

/** OpenAI 兼容 chat 模型：内网会话代理启用时按 provider/model-id 前缀路由渠道 */
export function createChatModel(modelId: string) {
  if (isConversationProxyEnabled()) {
    const { channel, modelId: bareModelId } = resolveChannelModel(modelId)
    return getInnerChatProvider(channel).chat(bareModelId)
  }
  return getProvider("chat").chat(normalizeModelId(modelId))
}

/**
 * embedding 端点为 OpenRouter 等 OpenAI 兼容路由时，模型 ID 必须保留完整
 * "provider/model" 形式（如 openai/text-embedding-3-small）；仅官方 OpenAI/Azure
 * 端点需要剥前缀。判定基于端点 host，业务模型名无需感知部署差异。
 */
function embeddingModelIdFor(modelId: string): string {
  const endpoint = getEmbeddingEndpoint()
  if (/^https?:\/\/[^/]*openrouter\.ai/i.test(endpoint.baseURL)) {
    return modelId
  }
  return normalizeModelId(modelId)
}

/** OpenAI 兼容 embedding 模型 */
export function createEmbeddingModel(modelId: string) {
  return getProvider("embedding").embedding(embeddingModelIdFor(modelId))
}

/** 兼容旧调用形态的别名 */
export const openaiChat = createChatModel
export const openaiEmbedding = createEmbeddingModel
