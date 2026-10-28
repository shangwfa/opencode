/**
 * 影刀内网代理（appreciation inner 协议）embedding 适配器。
 *
 * 自源工程 mastra/providers/openai.ts 的 handleEmbedding 迁移：
 * 标准 OpenAI `/embeddings` 请求被自定义 fetch 拦截，逐文本转为内网调用
 *   POST {XYBOT_AI_BASE_URL}/inner/langchain/rag/textEmbedding
 * 载荷（每文本一次）：{ bizCode, bizId, bizType, connectorUuid, channel, model, text }
 * 认证头：xybot-user（JSON 字符串）
 * 响应包装回 OpenAI 形状 { object:"list", data:[{object:"embedding",embedding,index}], model, usage }
 *
 * 由 KNOWLEDGE_EMBEDDING_CHANNEL=inner 显式启用（需 XYBOT_AI_BASE_URL），
 * 未启用时 embedding 走标准 OpenAI 兼容端点，行为不变。
 */

export interface InnerProxyConfig {
  baseURL: string
  userHeader: string
  bizCode: string
  bizId: string
  bizType: string
  connectorUuid: string
}

export function getInnerProxyConfig(): InnerProxyConfig {
  return {
    baseURL: (process.env["XYBOT_AI_BASE_URL"] || "").replace(/\/+$/, ""),
    userHeader: process.env["XYBOT_USER_HEADER"] || "{}",
    bizCode: process.env["PROXY_BIZ_CODE"] || "chatbot",
    bizId: process.env["PROXY_BIZ_ID"] || "",
    bizType: process.env["PROXY_BIZ_TYPE"] || "chat",
    connectorUuid: process.env["PROXY_CONNECTOR_UUID"] || "ac17aa97-c354-11ef-88bd-5ad92d0tca41",
  }
}

/** inner 代理 embedding 是否启用：显式 channel=inner 且配置了 XYBOT_AI_BASE_URL */
export function isInnerEmbeddingProxyEnabled(): boolean {
  return process.env["KNOWLEDGE_EMBEDDING_CHANNEL"] === "inner" && Boolean(process.env["XYBOT_AI_BASE_URL"])
}

/** 构造拦截 /embeddings 的自定义 fetch（供 createOpenAI 使用） */
export function createInnerEmbeddingFetch(): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const config = getInnerProxyConfig()
  const maxConcurrent = Number(process.env["KNOWLEDGE_INNER_EMBEDDING_MAX_CONCURRENT"] ?? 4)
  const limit = createSemaphore(maxConcurrent)

  return async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString()

    if (!url.includes("/embeddings")) {
      return fetch(input, init)
    }

    const body = init?.body ?? (input instanceof Request ? await input.text() : undefined)
    const payload = JSON.parse(String(body)) as { model?: string; input?: string | string[] }
    const model = payload.model || ""
    const texts: string[] = Array.isArray(payload.input) ? payload.input : [String(payload.input ?? "")]

    const results = await Promise.all(
      texts.map(async (text, index) => {
        const embedding = await limit(() => fetchEmbeddingWithRetry(config, model, text))
        return { object: "embedding", embedding, index }
      }),
    )

    return new Response(
      JSON.stringify({
        object: "list",
        data: results,
        model,
        usage: { prompt_tokens: 0, total_tokens: 0 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )
  }
}

/** ── 重试与并发控制 ─────────────────────────────────────────────── */

const RETRY_MAX_DELAY_MS = 5000

function getRetryOptions(): { maxRetries: number; baseDelayMs: number } {
  return {
    maxRetries: Number(process.env["KNOWLEDGE_INNER_EMBEDDING_MAX_RETRIES"] ?? 3),
    baseDelayMs: Number(process.env["KNOWLEDGE_INNER_EMBEDDING_RETRY_BASE_DELAY_MS"] ?? 500),
  }
}

/** 带重试的单文本 embedding：网络错误 / 非 2xx / success=false 均按指数退避重试 */
async function fetchEmbeddingWithRetry(config: InnerProxyConfig, model: string, text: string): Promise<number[]> {
  const { maxRetries, baseDelayMs } = getRetryOptions()
  let lastError: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(`${config.baseURL}/inner/langchain/rag/textEmbedding`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "xybot-user": config.userHeader,
        },
        body: JSON.stringify({
          bizCode: config.bizCode,
          bizId: config.bizId,
          bizType: config.bizType,
          connectorUuid: config.connectorUuid,
          channel: "azure",
          model,
          text,
        }),
      })
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }
      const json = (await res.json()) as { success?: boolean; data?: { embedding?: number[] }; msg?: string }
      if (!json.success || !json.data?.embedding) {
        throw new Error(json.msg ?? "Unknown error")
      }
      return json.data.embedding
    } catch (error) {
      lastError = error
      if (attempt < maxRetries) {
        await delay(Math.min(baseDelayMs * 2 ** attempt, RETRY_MAX_DELAY_MS))
      }
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(`Embedding failed after ${maxRetries + 1} attempts: ${message}`)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 简单信号量：限制同时在途的内网请求数 */
function createSemaphore(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0
  const queue: Array<() => void> = []

  return async (fn) => {
    if (active >= max) {
      await new Promise<void>((resolve) => queue.push(resolve))
    }
    active++
    try {
      return await fn()
    } finally {
      active--
      queue.shift()?.()
    }
  }
}

/**
 * 启动防御：本机设了 HTTP(S)_PROXY 时，内网主机名会被代理代答成 502
 * （Bun fetch 遵循小写 no_proxy，且支持运行时修改）。
 * 将 inner 代理主机追加到 no_proxy，避免每次部署手工配置遗漏。
 */
export function ensureNoProxyForInnerHost(): void {
  if (!isInnerEmbeddingProxyEnabled()) {
    return
  }
  const hasProxyEnv = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"].some(
    (key) => Boolean(process.env[key]),
  )
  const host = new URL(getInnerProxyConfig().baseURL).hostname
  const current = process.env["no_proxy"] ?? ""
  const entries = current.split(",").map((item) => item.trim()).filter(Boolean)

  if (entries.includes(host) || entries.includes("*")) {
    return
  }

  process.env["no_proxy"] = entries.length > 0 ? `${current},${host}` : host
  if (hasProxyEnv) {
    console.warn(
      `[inner-proxy] 检测到代理环境变量，已将 "${host}" 追加到 no_proxy（Bun fetch 仅识别小写 no_proxy）`,
    )
  }
}
