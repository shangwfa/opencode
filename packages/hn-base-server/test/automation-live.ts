/** 真实 SaaS/沙箱验收：启动独立基础服务后运行；只创建带前缀的测试用户、会话与应用，不清空环境。 */
import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { eq } from "drizzle-orm"
import type { AutomationApp as A } from "@opencode/schema/automation-app"
import { db, pool } from "../src/db"
import { automationApp, automationRun } from "../src/db/schema"
import { Schema } from "effect"
import { Model } from "@opencode/schema/model"
import { saasRunShell } from "../src/lib/saas"

const base = process.env.AUTOMATION_TEST_BASE ?? "http://localhost:15311"
const saas = process.env.OPENCODE_SAAS_URL ?? "http://localhost:15296"
const password = process.env.OPENCODE_PASSWORD
if (!password || (!process.env.BASE_DATABASE_SCHEMA?.startsWith("hn_automation_") && !process.env.AUTOMATION_TEST_EMAIL))
  throw new Error("需要测试 schema 和 OPENCODE_PASSWORD")
const folder = resolve("artifacts", `automation-live-${Date.now()}`)
mkdirSync(folder, { recursive: true })
const evidence: Record<string, unknown> = { base, started: new Date().toISOString(), cases: [] }
const events: unknown[] = []
let token = ""
const headers = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" })
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${base}/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: headers(),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(180_000),
  })
  if (!response.ok) throw new Error(`${path}: ${response.status} ${(await response.text()).slice(0, 500)}`)
  return (await response.json()) as T
}
const assert = (test: unknown, message: string) => {
  if (!test) throw new Error(message)
}
async function watch(sessionId: string, signal: AbortSignal) {
  const response = await fetch(`${saas}/api/session/${sessionId}/event`, {
    headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
    signal,
  })
  if (!response.ok || !response.body) throw new Error(`SSE ${response.status}`)
  const reader = response.body.getReader(),
    decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      let match: RegExpExecArray | null
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, match.index)
        buffer = buffer.slice(match.index + match[0].length)
        const raw = block
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n")
        if (!raw) continue
        try {
          const event = JSON.parse(raw)
          events.push(event)
          const payload = event.payload ?? event
          if (!/delta|streamed|usage/.test(payload.type ?? ""))
            console.log("SSE", payload.type, JSON.stringify(payload.properties ?? payload.data ?? {}).slice(0, 180))
        } catch {
          /* 心跳 */
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}
try {
  const email = process.env.AUTOMATION_TEST_EMAIL ?? `automation-live-${Date.now()}@example.com`
  const signup = await fetch(`${base}/api/auth/${process.env.AUTOMATION_TEST_EMAIL ? "sign-in" : "sign-up"}/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3001" },
    body: JSON.stringify({ email, password: "ab123456", name: "自动化验收" }),
  })
  assert(signup.ok, `注册失败 ${signup.status}`)
  token = signup.headers.get("set-auth-token") ?? ""
  assert(token, "未取得登录令牌")
  evidence.email = email
  const sessionId = process.env.AUTOMATION_SESSION_ID ?? (await api<{ session: { id: string } }>("/browser/sessions", { title: "自动化闭环验收" })).session.id
  evidence.sessionId = sessionId
  const abort = new AbortController()
  const watching = watch(sessionId, abort.signal).catch((error) => {
    if (!abort.signal.aborted) throw error
  })
  try {
    for (let i = 0; i < 180; i++) {
      const status = await api<{ status: string; error?: string }>(`/browser/sessions/${sessionId}/browser`)
      if (status.status === "failed") throw new Error(status.error)
      if (status.status === "ready") break
      if (i === 179) throw new Error("浏览器准备超时")
      await Bun.sleep(2000)
    }
    if (process.env.AUTOMATION_DRAFT_ONLY === "1") {
      const model = { id: "deepseek-v4-flash", providerID: "Yd-DeepSeek" }
      const prompt = await fetch(`${saas}/api/session/${sessionId}/prompt`, {
        method: "POST", headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "content-type": "application/json" },
        body: JSON.stringify({ text: "用 agent-browser --cdp http://127.0.0.1:9222 打开 https://example.com 并读取页面标题；完成后简短报告。请直接执行，不要提问。", model }),
      })
      assert(prompt.ok, `探索消息发送失败 ${prompt.status}`)
      const limit = Date.now() + 180_000
      while (Date.now() < limit) {
        const types = events.map((item) => ((item as { payload?: { type?: string }; type?: string }).payload ?? item as { type?: string }).type)
        if (types.includes("session.execution.failed") || types.includes("session.execution.interrupted")) throw new Error("探索执行失败或中断")
        if (types.includes("session.execution.succeeded")) break
        const forms = await api<{ data: Array<{ id: string; fields?: Array<{ key: string; type: string; options?: Array<{ value?: string }> }> }> }>(`/sessions/${sessionId}/forms`)
        for (const form of forms.data ?? []) {
          const answer = Object.fromEntries((form.fields ?? []).map((field) => [field.key, field.type === "boolean" ? true : field.options?.[0]?.value ?? "继续执行"]))
          await api(`/sessions/${sessionId}/forms/${form.id}/reply`, { answer })
          console.log("自动回答表单", form.id)
        }
        await Bun.sleep(2000)
      }
      assert(events.some((item) => ((item as { payload?: { type?: string }; type?: string }).payload ?? item as { type?: string }).type === "session.execution.succeeded"), "探索执行未完成")
      const draft = await api<{ definition: A.Definition }>("/automation-apps/draft", { sessionId })
      assert(draft.definition.steps.length > 0, "草稿没有步骤")
      evidence.draft = draft.definition
      const saved = await api<A.App>("/automation-apps", draft.definition)
      const run = await api<A.Run>(`/automation-apps/${saved.id}/runs`, { sessionId, requestKey: crypto.randomUUID(), parameters: {} })
      let current = run
      const end = Date.now() + 180_000
      while (Date.now() < end) {
        current = await api<A.Run>(`/automation-apps/runs/${run.id}`)
        if (current.status === "paused") {
          const reason = current.results[current.cursor]?.pauseReason
          if (reason !== "confirmation") throw new Error(`运行暂停：${current.error}`)
          await api(`/automation-apps/runs/${run.id}/resume`, { action: "confirm" })
        }
        if (current.status === "succeeded" || current.status === "failed") break
        await Bun.sleep(1500)
      }
      assert(current.status === "succeeded", `API 运行未成功：${current.status} ${current.error ?? ""}`)
      assert(current.results.some((result) => result.output?.includes("Example Domain")), "运行结果缺少预期页面标题")
      const [stored] = await db.select().from(automationRun).where(eq(automationRun.id, run.id))
      assert(stored?.status === "succeeded" && stored.appId === saved.id, "PG 运行记录不正确")
      evidence.appId = saved.id
      evidence.runId = run.id
      evidence.passed = true
      console.log("通过：真实 AI 探索 → 创建应用 → API 运行 → 结果与 PG 验证", saved.id, run.id)
    } else if (process.env.AUTOMATION_SCRIPT_REPAIR === "1") {
      const definition: A.Definition = {
        name: "数据处理修复验收", description: "验证修复需要确认", model: Schema.decodeUnknownSync(Model.Ref)({ id: process.env.AUTOMATION_MODEL_ID ?? "deepseek-v4-flash", providerID: process.env.AUTOMATION_PROVIDER_ID ?? "Yd-DeepSeek" }),
        parameters: [], steps: [{ id: "data", title: "计算并输出报告", operation: { type: "script", runtime: "python", source: "import json\ndata = {'count': 3}\nprint(json.dumps({'total': data['total']}))" } }],
      }
      const app = await api<A.App>("/automation-apps", definition)
      let run = await api<A.Run>(`/automation-apps/${app.id}/runs`, { sessionId, requestKey: crypto.randomUUID(), parameters: {} })
      evidence.appId = app.id; evidence.runId = run.id
      let phase = 0
      const deadline = Date.now() + 300_000
      while (Date.now() < deadline) {
        run = await api<A.Run>(`/automation-apps/runs/${run.id}`)
        console.log("脚本修复", run.status, "阶段", phase, run.error ?? "")
        if (run.status === "succeeded" || run.status === "failed") break
        if (run.status === "paused") {
          if (phase === 0 && run.results[0]?.pauseReason === "confirmation") {
            await api(`/automation-apps/runs/${run.id}/resume`, { action: "confirm" }); phase = 1
          } else if (phase === 1 && run.error?.includes("KeyError")) {
            run = await api<A.Run>(`/automation-apps/runs/${run.id}/repair`, {})
            assert(run.status === "paused" && !!run.results[0]?.repairedOperation, "修复草稿未暂停等待确认")
            const [unchanged] = await db.select().from(automationApp).where(eq(automationApp.id, app.id))
            assert(unchanged?.version === 1, "修复静默修改应用")
            console.log("自动回答：审核并确认运行修复后的脚本")
            await api(`/automation-apps/runs/${run.id}/resume`, { action: "confirm" }); phase = 2
          } else throw new Error(`意外暂停：${run.error}`)
        }
        await Bun.sleep(2000)
      }
      assert(run.status === "succeeded" && run.results[0]?.repairAttempts === 1, "脚本修复未成功")
      await api(`/automation-apps/runs/${run.id}/apply-repair`, {})
      const [stored] = await db.select().from(automationApp).where(eq(automationApp.id, app.id))
      assert(stored?.version === 2, "确认后应用版本未更新")
      evidence.run = run; evidence.passed = true
      console.log("通过：脚本异常 → AI 修复 → 用户确认 → 验证成功 → 更新应用")
    } else {
    const fixture = Buffer.from(
      '<!doctype html><meta charset="utf-8"><title>自动化回归</title><h1 id="current-heading">自动化验收标题</h1><p>用于验证固定执行与局部修复的确定性测试页面。</p>',
    ).toString("base64")
    const setup = await saasRunShell(
      sessionId,
      `mkdir -p /workspace/.automation-fixture && printf '%s' '${fixture}' | base64 -d > /workspace/.automation-fixture/index.html && (nohup python3 -m http.server 18765 --bind 127.0.0.1 --directory /workspace/.automation-fixture > /workspace/output/automation-fixture.log 2>&1 < /dev/null &)`,
    )
    assert(setup.exit === 0, "无法准备沙箱内确定性网页")
    const definition: A.Definition = {
      name: "网页信息汇总验收",
      description: "打开页面、修复定位、生成数据文件",
      model: Schema.decodeUnknownSync(Model.Ref)({ id: "deepseek-v4-flash", providerID: "Yd-DeepSeek" }),
      parameters: [{ key: "topic", label: "主题", required: true, defaultValue: "测试报告" }],
      steps: [
        {
          id: "open",
          title: "打开示例网页",
          operation: { type: "browser", action: "navigate", value: "http://127.0.0.1:18765" },
        },
        {
          id: "read",
          title: "提取网页主标题",
          operation: { type: "browser", action: "extract", selector: "#outdated-heading-selector" },
        },
        {
          id: "save",
          title: "把标题整理为报告文件",
          operation: {
            type: "script",
            runtime: "python",
            source: `import os,json,pathlib\np=json.loads(os.environ['AUTOMATION_INPUT'])\nr=json.loads(pathlib.Path(os.environ['AUTOMATION_RESULTS_PATH']).read_text())\nout={'topic':p['topic'],'heading':r['read']}\npathlib.Path('/workspace/output/automation-e2e.json').write_text(json.dumps(out,ensure_ascii=False))\nprint(json.dumps(out,ensure_ascii=False))`,
          },
        },
      ],
    }
    const app = await api<A.App>("/automation-apps", definition)
    evidence.appId = app.id
    const key = crypto.randomUUID()
    let run = await api<A.Run>(`/automation-apps/${app.id}/runs`, {
      sessionId,
      requestKey: key,
      parameters: { topic: "中文自动化报告" },
    })
    evidence.runId = run.id
    let confirmed = false
    const deadline = Date.now() + 300_000
    while (Date.now() < deadline) {
      run = await api<A.Run>(`/automation-apps/runs/${run.id}`)
      console.log("运行", run.status, `${run.cursor}/${definition.steps.length}`, run.error ?? "")
      if (run.status === "succeeded" || run.status === "failed") break
      if (run.status === "paused") {
        if (run.results[run.cursor]?.pauseReason === "confirmation" && !confirmed) {
          confirmed = true
          await api(`/automation-apps/runs/${run.id}/resume`, { action: "confirm" })
          console.log("自动回答：确认执行固定数据处理脚本")
        } else throw new Error(`意外暂停 ${run.error}`)
      }
      await Bun.sleep(2000)
    }
    evidence.run = run
    assert(run.status === "succeeded", "运行未成功")
    assert(run.results[1]?.repairAttempts === 1, "未验证局部修复")
    assert(run.results[2]?.output?.includes("自动化验收标题"), "数据处理未收到网页提取结果")
    const [before] = await db.select().from(automationApp).where(eq(automationApp.id, app.id))
    assert(before?.version === 1, "修复被静默保存")
    await api(`/automation-apps/runs/${run.id}/apply-repair`, {})
    const [storedApp] = await db.select().from(automationApp).where(eq(automationApp.id, app.id))
    const [storedRun] = await db.select().from(automationRun).where(eq(automationRun.id, run.id))
    assert(storedApp?.version === 2 && storedRun?.repairApplied && storedRun.cursor === 3, "PG 后检不一致")
    const artifactResponse = await fetch(
      `${base}/api/sessions/${sessionId}/fs/content?path=output/automation-e2e.json`,
      { headers: headers() },
    )
    assert(artifactResponse.ok, "无法读取报告产物")
    const payload = (await artifactResponse.json()) as { type?: string; content?: string; topic?: string; heading?: string }
    const artifact = (payload.type === "text" && payload.content ? JSON.parse(payload.content) : payload) as { topic: string; heading: string }
    assert(artifact.heading.includes("自动化验收标题") && artifact.topic === "中文自动化报告", "产物内容不正确")
    evidence.artifact = artifact
    evidence.pg = { appVersion: storedApp?.version, cursor: storedRun?.cursor, repairApplied: storedRun?.repairApplied }
    evidence.passed = true
    console.log("通过：网页 → 局部 AI 修复 → 数据处理 → 确认更新，PG 检查点一致")
    }
  } finally {
    abort.abort()
    await watching
  }
} catch (error) {
  evidence.passed = false
  evidence.error = error instanceof Error ? error.message : String(error)
  console.error("失败：", evidence.error)
  process.exitCode = 1
} finally {
  writeFileSync(resolve(folder, "result.json"), JSON.stringify(evidence, null, 2))
  writeFileSync(resolve(folder, "events.json"), JSON.stringify(events, null, 2))
  console.log("证据：", folder)
  await pool.end()
}
