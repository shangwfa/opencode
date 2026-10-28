/**
 * 影刀内网会话代理（appreciation inner 协议）chat 适配器。
 *
 * 自 xybot-front-node-ai src/mastra/providers/openai.ts 的 createProxyFetch 迁移（knowledge 场景最小集）：
 *   标准 OpenAI `/chat/completions` 请求被自定义 fetch 拦截，转发到内网会话代理
 *   POST {XYBOT_AI_BASE_URL}/inner/completions/conversation
 *   载荷 = OpenAI 参数 + { bizCode, bizId, bizType, channel, model, stream }
 *   认证头：xybot-user（JSON 字符串）；响应包装 { data: <OpenAI 响应> }，解包后返回。
 *
 * 与 embedding 代理（inner-proxy.ts）的区别：本代理面向 chat completions，按渠道路由
 * （openai/azure/deepseek/qwen/chatglm），knowledge 编译等 LLM 任务经此调用 gpt-5.6 等模型。
 * 由 KNOWLEDGE_LLM_CHANNEL=inner 显式启用（需 XYBOT_AI_BASE_URL），未启用时 chat 走标准
 * OpenAI 兼容端点，行为不变。
 */

/** OpenAI 兼容渠道：与 xybot-front-node-ai 的 OPENAI_COMPATIBLE_CHANNELS 保持一致 */
export const OPENAI_COMPATIBLE_CHANNELS = ['openai', 'azure', 'deepseek', 'qwen', 'chatglm'] as const
export type OpenAICompatibleChannel = (typeof OPENAI_COMPATIBLE_CHANNELS)[number]

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** 会话代理 chat 是否启用：显式 channel=inner 且配置了 XYBOT_AI_BASE_URL */
export function isConversationProxyEnabled(): boolean {
  return process.env.KNOWLEDGE_LLM_CHANNEL === 'inner' && Boolean(process.env.XYBOT_AI_BASE_URL)
}

/** 模型规格（provider/model-id）解析为渠道与裸模型名；无前缀视为 openai 渠道直连模型。 */
export function resolveChannelModel(modelSpec: string): { channel: OpenAICompatibleChannel; modelId: string } {
  const separator = modelSpec.indexOf('/')
  if (separator > 0) {
    const channel = modelSpec.slice(0, separator) as OpenAICompatibleChannel
    const modelId = modelSpec.slice(separator + 1)
    if (modelId && (OPENAI_COMPATIBLE_CHANNELS as readonly string[]).includes(channel)) {
      return { channel, modelId }
    }
  }
  return { channel: 'openai', modelId: modelSpec }
}

/** 内网代理不接受 developer 角色与 reasoning_content 字段，发送前规范化（源工程同款规则）。 */
function normalizeMessages(messages: unknown): unknown {
  if (!Array.isArray(messages)) return messages
  return messages.map(message => {
    if (!isRecord(message)) return message
    const { reasoning_content: _reasoningContent, ...rest } = message
    if (rest.role === 'developer') return { ...rest, role: 'system' }
    return rest
  })
}

/** 构造拦截 /chat/completions 的自定义 fetch（供 createOpenAI 使用）；其余请求原样透传。 */
export function createConversationProxyFetch(
  channel: OpenAICompatibleChannel,
  baseFetch: typeof fetch = fetch,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    if (!url.includes('/chat/completions')) {
      return baseFetch(input as any, init)
    }

    const body = init?.body ?? (input instanceof Request ? await input.text() : undefined)
    const payload = JSON.parse(String(body)) as Record<string, unknown>
    const { stream: isStream = false, model: modelId, ...rest } = payload
    const proxyPayload = {
      ...rest,
      messages: normalizeMessages(rest.messages),
      bizCode: process.env.PROXY_BIZ_CODE ?? 'chatbot',
      bizId: process.env.PROXY_BIZ_ID,
      bizType: process.env.PROXY_BIZ_TYPE ?? 'chat',
      channel,
      model: modelId,
      stream: isStream,
    }

    const proxyResponse = await baseFetch(
      `${(process.env.XYBOT_AI_BASE_URL ?? '').replace(/\/+$/, '')}/inner/completions/conversation`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xybot-user': process.env.XYBOT_USER_HEADER ?? '{}',
        },
        signal: init?.signal,
        body: JSON.stringify(proxyPayload),
      },
    )

    // 非流式：解包 { data: <OpenAI 响应> }；错误包装原样透传，不伪装成功。
    const wrapper = await proxyResponse.json().catch(() => null)
    if (!proxyResponse.ok || !isRecord(wrapper) || !isRecord(wrapper.data)) {
      return new Response(JSON.stringify(wrapper ?? { error: { message: `conversation proxy ${proxyResponse.status}` } }), {
        status: proxyResponse.status,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify(wrapper.data), {
      status: proxyResponse.status,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
