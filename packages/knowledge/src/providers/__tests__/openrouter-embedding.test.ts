import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test"

const createOpenAIMock = mock(() => ({ embedding: (id: string) => ({ modelId: id }) }))
mock.module("@ai-sdk/openai", () => ({ createOpenAI: createOpenAIMock }))

const { createEmbeddingModel, resetLLMProviderCache } = await import("../llm.js")

const ENDPOINT_KEYS = [
  "KNOWLEDGE_EMBEDDING_BASE_URL", "KNOWLEDGE_EMBEDDING_API_KEY",
  "KNOWLEDGE_LLM_BASE_URL", "KNOWLEDGE_LLM_API_KEY",
]
let envSnapshot: Record<string, string | undefined> = {}

describe("OpenRouter embedding 模型 ID 归一", () => {
  beforeEach(() => {
    // bun 会自动加载 .env；快照后清空端点回退链，结束时恢复，避免泄漏到同进程其它用例
    envSnapshot = Object.fromEntries(ENDPOINT_KEYS.map((k) => [k, process.env[k]]))
    for (const key of ENDPOINT_KEYS) delete process.env[key]
    createOpenAIMock.mockClear()
    resetLLMProviderCache()
  })

  afterEach(() => {
    for (const key of ENDPOINT_KEYS) {
      if (envSnapshot[key] === undefined) delete process.env[key]
      else process.env[key] = envSnapshot[key]
    }
    resetLLMProviderCache()
  })

  it("OpenRouter 端点保留 provider/model 完整 ID", () => {
    process.env.KNOWLEDGE_EMBEDDING_BASE_URL = "https://openrouter.ai/api/v1"
    const model = createEmbeddingModel("openai/text-embedding-3-small") as unknown as { modelId: string }
    expect(model.modelId).toBe("openai/text-embedding-3-small")
  })

  it("官方 OpenAI 端点剥 provider 前缀", () => {
    const model = createEmbeddingModel("openai/text-embedding-3-small") as unknown as { modelId: string }
    expect(model.modelId).toBe("text-embedding-3-small")
  })
})
