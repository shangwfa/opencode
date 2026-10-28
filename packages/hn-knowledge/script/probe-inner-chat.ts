/** 直接探测 inner 代理：structured 与 text 两种请求形态 */
const base = process.env.XYBOT_AI_BASE_URL!
const header = process.env.XYBOT_USER_HEADER ?? '{}'
const payload = (extra: Record<string, unknown>) => ({
  model: process.env.KNOWLEDGE_DEFAULT_CHAT_MODEL || 'openai/gpt-5.6',
  messages: [{ role: 'user', content: '输出一个 JSON 对象 {"ok":true}' }],
  temperature: 0,
  bizCode: process.env.PROXY_BIZ_CODE,
  bizId: process.env.PROXY_BIZ_ID,
  bizType: 'chat',
  channel: process.env.KNOWLEDGE_LLM_CHANNEL === 'inner' ? undefined : undefined,
  ...extra,
})
for (const [name, extra] of [
  ['plain', {}],
  ['json_object', { response_format: { type: 'json_object' } }],
  ['json_schema', { response_format: { type: 'json_schema', json_schema: { name: 't', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } } } }],
] as Array<[string, Record<string, unknown>]>) {
  const res = await fetch(`${base.replace(/\/+$/, '')}/inner/completions/conversation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'xybot-user': header },
    body: JSON.stringify(payload(extra)),
  })
  const text = await res.text()
  console.log(JSON.stringify({ name, status: res.status, body: text.slice(0, 400) }))
}
