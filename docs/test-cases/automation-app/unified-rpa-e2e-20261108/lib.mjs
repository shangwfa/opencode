/**
 * 统一自动化应用真实 E2E 公共库。
 * 用例：用户输入任务 → 会话讨论并真实执行 → 确认满足需求 → 沉淀（发布）应用 → 触发应用执行。
 * 依据 docs/test-cases/automation-app/streaming-output-spec.md：过程必须实时可见、表单自动代答、
 * 结论以落盘证据为准。BASE 指向本地 hn-base-server（15301）。
 */
export const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:15301"
export const EMAIL = "demo@example.com"
export const PASSWORD = "ab123456"
export const DIR = new URL(".", import.meta.url).pathname
const TASK = [
  "请在当前工作区完成「每日订单汇总」任务，并真实执行验证：",
  "1) 创建 data/orders.csv，写入表头 order_id,amount 和 5 行示例订单数据；",
  "2) 用 Python 读取该文件并计算金额总和；",
  "3) 把汇总结果写入 output/report.json，格式为 {\"total\": <数值>, \"count\": <订单数>}；",
  "4) 在回复中说明汇总结果。全程只使用本地沙箱文件，不要访问网络或登录任何系统。",
].join("\n")
export { TASK }

export async function signIn() {
  const res = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3001" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })
  if (!res.ok) throw new Error(`登录失败 ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const token = res.headers.get("set-auth-token")
  if (!token) throw new Error("登录成功但未返回 set-auth-token")
  return token
}

export function api(token) {
  return async function request(method, path, body, timeoutMs = 30_000) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(Number.isFinite(timeoutMs) ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    })
    const text = await res.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch {}
    return { status: res.status, ok: res.ok, body: json, text: text.slice(0, 500) }
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
export const log = (...parts) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...parts)

/** 表单自动代答：只处理 pending 的 question 表单；连续两次 400 即跳过，避免饿死执行。 */
export async function answerForms(request, sessionId, trace) {
  const list = await request("GET", `/api/sessions/${sessionId}/forms`, undefined, 10_000)
  const forms = list.body?.data ?? []
  for (const form of Array.isArray(forms) ? forms : []) {
    if (form.metadata?.kind !== "question") continue
    if (trace.forms.filter((item) => item.formID === form.id && item.status === 400).length >= 2) continue
    const answer = {}
    for (const field of form.fields ?? []) {
      if (field.type === "external") continue
      if (field.type === "boolean") answer[field.key] = field.default ?? true
      else if (field.type === "number" || field.type === "integer") answer[field.key] = field.default ?? field.minimum ?? 1
      else if (field.type === "multiselect") answer[field.key] = [field.options?.[0]?.value ?? field.default?.[0]].filter(Boolean)
      else answer[field.key] = field.options?.[0]?.value ?? field.default ?? "由验收器代答：请按推荐方案继续"
    }
    const replied = await request("POST", `/api/sessions/${sessionId}/forms/${form.id}/reply`, { answer }, 10_000)
    trace.forms.push({ formID: form.id, status: replied.status, answer })
    log(`form ${replied.ok ? "✓" : `✗ ${replied.status}`} ${form.id}`)
  }
}

/** 权限自动放行（仅本次）。 */
export async function answerPermissions(request, sessionId, trace) {
  const list = await request("GET", `/api/sessions/${sessionId}/permissions`, undefined, 10_000)
  const pending = list.body?.data ?? []
  for (const item of Array.isArray(pending) ? pending : []) {
    if (item.status && item.status !== "pending") continue
    const replied = await request("POST", `/api/sessions/${sessionId}/permissions/${item.id}/reply`, { decision: "once" }, 10_000)
    trace.permissions.push({ id: item.id, status: replied.status })
    log(`permission ${replied.ok ? "✓ once" : `✗ ${replied.status}`} ${item.id}`)
  }
}

/** 轮询会话消息，等待 promptMessageID 对应的 assistant 完成或失败。 */
export async function waitAssistant(request, sessionId, promptId, trace, timeoutMs = 15 * 60_000) {
  const end = Date.now() + timeoutMs
  let lastCount = 0
  while (Date.now() < end) {
    await sleep(4000)
    await answerForms(request, sessionId, trace).catch(() => undefined)
    await answerPermissions(request, sessionId, trace).catch(() => undefined)
    const messages = await request("GET", `/api/sessions/${sessionId}/messages`, undefined, 15_000)
    const list = messages.body?.data ?? []
    if (list.length !== lastCount) {
      lastCount = list.length
      log(`messages=${list.length}`)
    }
    const answers = list.filter((m) => m.type === "assistant" && m.promptMessageID === promptId)
    const done = answers.filter((m) => m.time?.completed)
    if (answers.length && done.length === answers.length) {
      const text = done.map((m) => (m.content ?? []).filter((p) => p.type === "text").map((p) => p.text).join("\n")).join("\n")
      return { done: true, text: text.slice(-2500), parts: answers.length, errored: answers.some((m) => m.error) }
    }
  }
  return { done: false, timeout: true }
}

/** 创建会话并返回 sessionId；必须显式选模型，否则模型轮会立即失败。 */
export async function createSession(request, title, model = { providerID: "Yd-DeepSeek", modelID: "deepseek-v4-1-flash-261017" }) {
  const res = await request("POST", "/api/sessions", { title, model }, 60_000)
  if (!res.ok) throw new Error(`创建会话失败 ${res.status}: ${res.text}`)
  const id = res.body?.session?.id ?? res.body?.id ?? res.body?.data?.id
  if (!id) throw new Error(`创建会话响应缺少 id: ${JSON.stringify(res.body).slice(0, 200)}`)
  return id
}
