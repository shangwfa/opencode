import { describe, expect, it, mock, beforeEach } from 'bun:test'

const mockFetch = mock(async (_url: unknown, _init?: RequestInit) => new Response('{}'))

mock.module('../../config/env.js', () => ({
  getChatEndpoint: () => ({ baseURL: 'https://std.example/v1', apiKey: 'key' }),
  getEmbeddingEndpoint: () => ({ baseURL: 'https://std.example/v1', apiKey: 'key' }),
  getDefaultChatModel: () => 'openai/gpt-5.6',
  normalizeModelId: (id: string) => id,
}))

const { createConversationProxyFetch, isConversationProxyEnabled, resolveChannelModel } = await import('../../providers/conversation-proxy.js')

describe('内网会话代理（conversation proxy）', () => {
  beforeEach(() => {
    mockFetch.mockClear()
    delete process.env.KNOWLEDGE_LLM_CHANNEL
    delete process.env.XYBOT_AI_BASE_URL
    delete process.env.PROXY_BIZ_CODE
    delete process.env.PROXY_BIZ_ID
    delete process.env.PROXY_BIZ_TYPE
  })

  it('未显式启用或缺少 XYBOT_AI_BASE_URL 时不启用', () => {
    expect(isConversationProxyEnabled()).toBe(false)
    process.env.XYBOT_AI_BASE_URL = 'https://xy.example'
    expect(isConversationProxyEnabled()).toBe(false)
    process.env.KNOWLEDGE_LLM_CHANNEL = 'inner'
    expect(isConversationProxyEnabled()).toBe(true)
  })

  it('模型规格解析为渠道与裸模型名', () => {
    expect(resolveChannelModel('openai/gpt-5.6')).toEqual({ channel: 'openai', modelId: 'gpt-5.6' })
    expect(resolveChannelModel('chatglm/glm-5')).toEqual({ channel: 'chatglm', modelId: 'glm-5' })
    expect(resolveChannelModel('azure/gpt-5.4-mini')).toEqual({ channel: 'azure', modelId: 'gpt-5.4-mini' })
    expect(resolveChannelModel('glm-4.6')).toEqual({ channel: 'openai', modelId: 'glm-4.6' })
  })

  it('chat 请求包装内网协议：biz 字段、channel、模型名、xybot-user 头', async () => {
    process.env.XYBOT_AI_BASE_URL = 'https://xy.example/'
    process.env.PROXY_BIZ_CODE = 'wiki'
    process.env.PROXY_BIZ_ID = 'biz-1'
    process.env.XYBOT_USER_HEADER = '{"name":"t"}'
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ data: { id: 'x', choices: [{ message: { role: 'assistant', content: 'ok' } }] } }), { status: 200 }))
    const proxyFetch = createConversationProxyFetch('openai', mockFetch as any)

    const response = await proxyFetch('https://std.example/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-5.6', messages: [{ role: 'user', content: 'hi' }], stream: false }),
    })

    expect(response.status).toBe(200)
    const body = JSON.parse(await response.text())
    expect(body.choices[0].message.content).toBe('ok')
    const [url, init] = mockFetch.mock.calls.at(-1)!
    expect(String(url)).toBe('https://xy.example/inner/completions/conversation')
    const payload = JSON.parse(String(init!.body))
    expect(payload).toMatchObject({ bizCode: 'wiki', bizId: 'biz-1', bizType: 'chat', channel: 'openai', model: 'gpt-5.6', stream: false })
    expect(new Headers(init!.headers).get('xybot-user')).toBe('{"name":"t"}')
    expect(payload.sessionId).toBeUndefined()
  })

  it('developer 角色降级为 system，reasoning_content 剔除', async () => {
    process.env.XYBOT_AI_BASE_URL = 'https://xy.example'
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ data: {} }), { status: 200 }))
    const proxyFetch = createConversationProxyFetch('openai', mockFetch as any)
    await proxyFetch('https://std.example/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-5.6', stream: false, messages: [
        { role: 'developer', content: 'sys' },
        { role: 'assistant', content: 'r', reasoning_content: 'hidden' },
      ] }),
    })
    const payload = JSON.parse(String(mockFetch.mock.calls.at(-1)![1]!.body))
    expect(payload.messages).toEqual([{ role: 'system', content: 'sys' }, { role: 'assistant', content: 'r' }])
  })

  it('代理错误包装透传状态码与原文，不伪装成功', async () => {
    process.env.XYBOT_AI_BASE_URL = 'https://xy.example'
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ code: '1302', msg: '限流' }), { status: 429 }))
    const proxyFetch = createConversationProxyFetch('openai', mockFetch as any)
    const response = await proxyFetch('https://std.example/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-5.6', messages: [], stream: false }),
    })
    expect(response.status).toBe(429)
    expect(JSON.parse(await response.text())).toMatchObject({ code: '1302' })
  })

  it('非 chat 请求（embeddings 等）不经代理直连', async () => {
    process.env.XYBOT_AI_BASE_URL = 'https://xy.example'
    mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }))
    const proxyFetch = createConversationProxyFetch('openai', mockFetch as any)
    await proxyFetch('https://std.example/v1/embeddings', { method: 'POST', body: '{}' })
    expect(String(mockFetch.mock.calls.at(-1)![0])).toBe('https://std.example/v1/embeddings')
  })
})
