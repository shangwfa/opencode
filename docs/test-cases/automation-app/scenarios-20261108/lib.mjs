/**
 * 多场景真实 E2E 公共库（v2）。
 * 修正统一用例 v1 的两个问题：
 * 1) 等待讨论完成不再只看 assistant.completed（分段完成会提前返回），等待 turn 后的 idle 消息。
 * 2) 「无模型」断言按消息类型统计（user/assistant），执行器的 shell/文件消息不计入。
 */
export const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:15301"
export const SAAS = process.env.E2E_SAAS ?? "http://localhost:14096"
export const SAAS_PASSWORD = "ab123456"
export const EMAIL = "demo@example.com"
export const PASSWORD = "ab123456"
const MODEL = { providerID: "Yd-DeepSeek", modelID: "deepseek-v4-1-flash-261017" }

export async function signIn() {
  const res = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3001" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })
  if (!res.ok) throw new Error(`登录失败 ${res.status}`)
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
    trace.forms.push({ formID: form.id, status: replied.status })
    log(`form ${replied.ok ? "✓" : `✗ ${replied.status}`} ${form.id}`)
  }
}

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

/** 创建会话：显式选模型，否则模型轮立即失败。 */
export async function createSession(request, title) {
  const res = await request("POST", "/api/sessions", { title, model: MODEL }, 60_000)
  if (!res.ok) throw new Error(`创建会话失败 ${res.status}: ${res.text}`)
  const id = res.body?.session?.id ?? res.body?.id ?? res.body?.data?.id
  if (!id) throw new Error(`创建会话响应缺少 id: ${JSON.stringify(res.body).slice(0, 200)}`)
  return id
}

/** 计算消息类型分布，用于「无模型」断言。 */
export function typedCounts(body) {
  const list = body?.data ?? []
  return {
    prompts: list.filter((m) => m.type === "user").length,
    assistants: list.filter((m) => m.type === "assistant").length,
    total: list.length,
  }
}

async function messages(request, sessionId) {
  const res = await request("GET", `/api/sessions/${sessionId}/messages`, undefined, 15_000)
  return res.body?.data ?? []
}

/**
 * 等待一轮讨论完成：以本轮 prompt 之后的 idle 消息为准（模型分段 completed 会提前返回），
 * 兜底：assistant 全部 completed 且 30 秒无新消息。期间表单/权限自动代答。
 */
export async function waitTurn(request, sessionId, promptId, trace, timeoutMs = 15 * 60_000) {
  const end = Date.now() + timeoutMs
  let promptCreated = 0
  let lastCount = 0
  let lastChange = Date.now()
  let settled = false
  while (Date.now() < end) {
    await sleep(4000)
    await answerForms(request, sessionId, trace).catch(() => undefined)
    await answerPermissions(request, sessionId, trace).catch(() => undefined)
    const list = await messages(request, sessionId)
    if (list.length !== lastCount) { lastCount = list.length; lastChange = Date.now(); log(`messages=${list.length}`) }
    const prompt = list.find((m) => m.id === promptId)
    if (prompt?.time?.created) promptCreated = prompt.time.created
    if (promptCreated) {
      if (list.some((m) => m.type === "idle" && (m.time?.created ?? 0) > promptCreated)) settled = true
      else {
        const mine = list.filter((m) => m.type === "assistant" && m.promptMessageID === promptId)
        if (mine.length && mine.every((m) => m.time?.completed) && Date.now() - lastChange > 30_000) settled = true
      }
    }
    if (settled) {
      const text = list
        .filter((m) => m.type === "assistant" && m.promptMessageID === promptId)
        .map((m) => (m.content ?? []).filter((p) => p.type === "text").map((p) => p.text).join("\n"))
        .join("\n")
      return { done: true, text: text.slice(-1500) }
    }
  }
  return { done: false, timeout: true }
}

export async function countNow(request, sessionId) {
  return typedCounts(await messages(request, sessionId))
}

/** 读取本次运行独立目录下的产物。 */
export async function readArtifact(request, sessionId, runId, relative) {
  const res = await request("GET", `/api/sessions/${sessionId}/fs/content?path=${encodeURIComponent(`output/automation/${runId}/${relative}`)}`, undefined, 30_000)
  return { status: res.status, content: res.body?.content ?? (res.ok ? "" : res.text.slice(0, 200)) }
}
