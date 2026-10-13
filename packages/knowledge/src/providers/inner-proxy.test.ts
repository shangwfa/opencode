/**
 * inner 代理 embedding 适配器单测：
 * stub global fetch，验证 /embeddings 拦截、内网信封、OpenAI 形状包装、透传与开关。
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { embed } from 'ai'

import { resetLLMProviderCache, openaiEmbedding } from './llm.js'
import {
  createInnerEmbeddingFetch,
  ensureNoProxyForInnerHost,
  getInnerProxyConfig,
  isInnerEmbeddingProxyEnabled,
} from './inner-proxy.js'

const ORIGINAL_ENV = { ...process.env }

function setEnv(patch: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

const INNER_BASE = 'http://inner-proxy.test/api/appreciation/v1'
const EMBEDDING = [0.1, 0.2, 0.3]

let calls: Array<{ url: string; headers: Record<string, string>; body: any }> = []
let innerSuccess = true

const realFetch = globalThis.fetch

beforeEach(() => {
  calls = []
  innerSuccess = true
  setEnv({
    XYBOT_AI_BASE_URL: INNER_BASE,
    XYBOT_USER_HEADER: '{"name":"kb-test","tenantUuid":"kb-test","uuid":"kb-test"}',
    PROXY_BIZ_CODE: 'knowledge-test',
    PROXY_BIZ_ID: 'biz-001',
    PROXY_BIZ_TYPE: undefined,
    PROXY_CONNECTOR_UUID: undefined,
    KNOWLEDGE_EMBEDDING_CHANNEL: undefined,
  })
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url
    if (url.includes('/embeddings')) {
      throw new Error('inner adapter not wired: standard embedding call leaked')
    }
    const headers = Object.fromEntries(Object.entries(init?.headers ?? {}).map(([k, v]) => [k, String(v)]))
    calls.push({ url, headers, body: JSON.parse(init?.body) })
    if (!innerSuccess) {
      return new Response(JSON.stringify({ success: false, msg: 'quota exceeded' }), { status: 200 })
    }
    return new Response(
      JSON.stringify({ success: true, data: { embedding: EMBEDDING } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as any
})

afterEach(() => {
  globalThis.fetch = realFetch
  process.env = { ...ORIGINAL_ENV }
  resetLLMProviderCache()
})

describe('isInnerEmbeddingProxyEnabled', () => {
  it('默认关闭', () => {
    expect(isInnerEmbeddingProxyEnabled()).toBe(false)
  })

  it('channel=inner 且配置了 XYBOT_AI_BASE_URL 时开启', () => {
    setEnv({ KNOWLEDGE_EMBEDDING_CHANNEL: 'inner' })
    expect(isInnerEmbeddingProxyEnabled()).toBe(true)
  })

  it('channel=inner 但缺 XYBOT_AI_BASE_URL 时关闭', () => {
    setEnv({ KNOWLEDGE_EMBEDDING_CHANNEL: 'inner', XYBOT_AI_BASE_URL: undefined })
    expect(isInnerEmbeddingProxyEnabled()).toBe(false)
  })
})

describe('getInnerProxyConfig', () => {
  it('读取 env 并应用默认值', () => {
    const config = getInnerProxyConfig()
    expect(config.baseURL).toBe(INNER_BASE)
    expect(config.userHeader).toContain('kb-test')
    expect(config.bizCode).toBe('knowledge-test')
    expect(config.bizId).toBe('biz-001')
    expect(config.bizType).toBe('chat')
    expect(config.connectorUuid).toBe('ac17aa97-c354-11ef-88bd-5ad92d0tca41')
  })
})

describe('createInnerEmbeddingFetch', () => {
  it('拦截 /embeddings：逐文本调用内网端点并包装为 OpenAI 形状', async () => {
    const innerFetch = createInnerEmbeddingFetch()
    const res = await innerFetch('http://kb.test/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: ['文档一', '文档二'] }),
    })
    const json: any = await res.json()

    expect(calls).toHaveLength(2)
    for (const call of calls) {
      expect(call.url).toBe(`${INNER_BASE}/inner/langchain/rag/textEmbedding`)
      expect(call.headers['xybot-user']).toContain('kb-test')
      expect(call.body.channel).toBe('azure')
      expect(call.body.model).toBe('text-embedding-3-small')
    }
    expect(calls[0].body.text).toBe('文档一')
    expect(calls[0].body.bizCode).toBe('knowledge-test')
    expect(calls[0].body.bizId).toBe('biz-001')
    expect(calls[1].body.text).toBe('文档二')

    expect(json.object).toBe('list')
    expect(json.model).toBe('text-embedding-3-small')
    expect(json.data).toHaveLength(2)
    expect(json.data[0]).toMatchObject({ object: 'embedding', index: 0, embedding: EMBEDDING })
    expect(json.data[1].index).toBe(1)
  })

  it('input 为字符串时单次调用', async () => {
    const innerFetch = createInnerEmbeddingFetch()
    const res = await innerFetch('http://kb.test/v1/embeddings', {
      method: 'POST',
      body: JSON.stringify({ model: 'm', input: '单条' }),
    })
    const json: any = await res.json()
    expect(calls).toHaveLength(1)
    expect(calls[0].body.text).toBe('单条')
    expect(json.data[0].embedding).toEqual(EMBEDDING)
  })

  it('内网返回 success=false 时抛错并携带 msg', async () => {
    innerSuccess = false
    const innerFetch = createInnerEmbeddingFetch()
    expect(
      innerFetch('http://kb.test/v1/embeddings', {
        method: 'POST',
        body: JSON.stringify({ model: 'm', input: 'x' }),
      }),
    ).rejects.toThrow('quota exceeded')
  })

  it('非 /embeddings 请求透传 global fetch', async () => {
    const innerFetch = createInnerEmbeddingFetch()
    const res = await innerFetch('http://kb.test/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ messages: [] }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true })
  })
})

describe('openaiEmbedding × inner channel 集成', () => {
  it('channel=inner 时 ai-sdk embed 经内网代理完成向量化', async () => {
    setEnv({
      KNOWLEDGE_EMBEDDING_CHANNEL: 'inner',
      KNOWLEDGE_EMBEDDING_BASE_URL: 'http://kb.test/v1',
      KNOWLEDGE_EMBEDDING_API_KEY: 'unused',
    })
    resetLLMProviderCache()
    const model = openaiEmbedding('openai/text-embedding-3-small')
    const { embedding } = await embed({ model, value: '影刀文档同步测试' })
    expect(embedding).toEqual(EMBEDDING)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${INNER_BASE}/inner/langchain/rag/textEmbedding`)
  })
})

describe('重试与并发控制', () => {
  it('临时失败按指数退避重试后成功', async () => {
    setEnv({
      KNOWLEDGE_EMBEDDING_CHANNEL: 'inner',
      KNOWLEDGE_INNER_EMBEDDING_MAX_RETRIES: '2',
      KNOWLEDGE_INNER_EMBEDDING_RETRY_BASE_DELAY_MS: '1',
    })
    let failures = 0
    ;(globalThis.fetch as any) = async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('/embeddings')) throw new Error('leak')
      calls.push({ url, headers: {}, body: JSON.parse(init?.body) })
      failures++
      if (failures <= 2) {
        return new Response(JSON.stringify({ success: false, msg: 'transient' }), { status: 200 })
      }
      return new Response(JSON.stringify({ success: true, data: { embedding: EMBEDDING } }), { status: 200 })
    }
    const innerFetch = createInnerEmbeddingFetch()
    const res = await innerFetch('http://kb.test/v1/embeddings', {
      method: 'POST',
      body: JSON.stringify({ model: 'm', input: '重试文本' }),
    })
    const json: any = await res.json()
    expect(failures).toBe(3)
    expect(json.data[0].embedding).toEqual(EMBEDDING)
  })

  it('重试耗尽后抛出最后一次错误', async () => {
    setEnv({
      KNOWLEDGE_EMBEDDING_CHANNEL: 'inner',
      KNOWLEDGE_INNER_EMBEDDING_MAX_RETRIES: '1',
      KNOWLEDGE_INNER_EMBEDDING_RETRY_BASE_DELAY_MS: '1',
    })
    innerSuccess = false
    const innerFetch = createInnerEmbeddingFetch()
    expect(
      innerFetch('http://kb.test/v1/embeddings', {
        method: 'POST',
        body: JSON.stringify({ model: 'm', input: 'x' }),
      }),
    ).rejects.toThrow('after 2 attempts')
  })

  it('在途请求不超过并发上限', async () => {
    setEnv({
      KNOWLEDGE_EMBEDDING_CHANNEL: 'inner',
      KNOWLEDGE_INNER_EMBEDDING_MAX_CONCURRENT: '2',
    })
    let inFlight = 0
    let maxInFlight = 0
    ;(globalThis.fetch as any) = async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('/embeddings')) throw new Error('leak')
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 20))
      inFlight--
      return new Response(JSON.stringify({ success: true, data: { embedding: EMBEDDING } }), { status: 200 })
    }
    const innerFetch = createInnerEmbeddingFetch()
    const texts = Array.from({ length: 6 }, (_, i) => `文本${i}`)
    const res = await innerFetch('http://kb.test/v1/embeddings', {
      method: 'POST',
      body: JSON.stringify({ model: 'm', input: texts }),
    })
    const json: any = await res.json()
    expect(json.data).toHaveLength(6)
    expect(maxInFlight).toBeLessThanOrEqual(2)
  })
})

describe('ensureNoProxyForInnerHost', () => {
  it('把内网主机追加到小写 no_proxy', async () => {
    setEnv({ KNOWLEDGE_EMBEDDING_CHANNEL: 'inner', no_proxy: undefined, http_proxy: 'http://127.0.0.1:7897' })
    ensureNoProxyForInnerHost()
    expect(process.env['no_proxy']).toBe('inner-proxy.test')
  })

  it('已包含主机或 * 时不重复追加', async () => {
    setEnv({ KNOWLEDGE_EMBEDDING_CHANNEL: 'inner', no_proxy: 'inner-proxy.test,localhost' })
    ensureNoProxyForInnerHost()
    expect(process.env['no_proxy']).toBe('inner-proxy.test,localhost')
    setEnv({ no_proxy: '*' })
    ensureNoProxyForInnerHost()
    expect(process.env['no_proxy']).toBe('*')
  })

  it('inner 未启用时不修改 no_proxy', async () => {
    setEnv({ KNOWLEDGE_EMBEDDING_CHANNEL: undefined, no_proxy: undefined })
    ensureNoProxyForInnerHost()
    expect(process.env['no_proxy']).toBeUndefined()
  })
})
