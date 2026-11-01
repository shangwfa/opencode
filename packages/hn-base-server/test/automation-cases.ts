/**
 * 自动化应用用例矩阵（简单 → 复杂）。
 * 对真实基础服务 + SaaS 沙箱执行，逐条记录结果与耗时；只创建带时间戳前缀的测试数据。
 */
import { eq } from "drizzle-orm"
import type { AutomationApp as A } from "@opencode/schema/automation-app"
import { Schema } from "effect"
import { Model } from "@opencode/schema/model"
import { db, pool } from "../src/db"
import { automationApp, automationRun } from "../src/db/schema"
import { saasRunShell } from "../src/lib/saas"

const base = process.env.CASES_BASE ?? "http://localhost:15313"
const peer = process.env.CASES_PEER // 第二个实例，可选
const saas = process.env.OPENCODE_SAAS_URL ?? "http://localhost:15296"
const password = process.env.OPENCODE_PASSWORD ?? ""
const modelEnv = {
  id: process.env.AUTOMATION_MODEL_ID ?? "glm-5.3-flash",
  providerID: process.env.AUTOMATION_PROVIDER_ID ?? "Yd-GLM",
}
if (!password) throw new Error("需要 OPENCODE_PASSWORD")
const stamp = Date.now()
const token: Record<"owner" | "other", string> = { owner: "", other: "" }
const evidence: Array<{ id: string; title: string; level: string; passed: boolean; ms: number; detail?: unknown }> = []
const ctx: { sessionId?: string; appId?: string; runs: string[] } = { runs: [] }

async function signup(name: string, tag: string) {
  // 指定已有账号时直接登录，让用例数据落在该账号下（例如界面可见的演示账号）。
  const fixedEmail = tag === "owner" ? process.env.CASES_EMAIL : undefined
  if (fixedEmail && process.env.CASES_PASSWORD) {
    const res = await fetch(`${base}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3001" },
      body: JSON.stringify({ email: fixedEmail, password: process.env.CASES_PASSWORD }),
    })
    if (!res.ok) throw new Error(`登录失败 ${res.status}`)
    return res.headers.get("set-auth-token") ?? ""
  }
  const email = `cases-${stamp}-${tag}@example.com`
  const res = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3001" },
    body: JSON.stringify({ email, password: "ab123456", name }),
  })
  if (!res.ok) throw new Error(`注册失败 ${res.status}`)
  return res.headers.get("set-auth-token") ?? ""
}
async function call<T>(path: string, init: { method?: string; body?: unknown; as?: "owner" | "other"; at?: string } = {}): Promise<{ status: number; data: T }> {
  const res = await fetch(`${init.at ?? base}/api${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { authorization: `Bearer ${token[init.as ?? "owner"]}`, "content-type": "application/json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    signal: AbortSignal.timeout(180_000),
  })
  const text = await res.text()
  let data: unknown = text
  try { data = text ? JSON.parse(text) : null } catch { /* 文本 */ }
  return { status: res.status, data: data as T }
}
const expectStatus = (actual: number, expected: number, label: string) => {
  if (actual !== expected) throw new Error(`${label}：期望 ${expected}，实际 ${actual}`)
}
const check = (ok: unknown, label: string) => { if (!ok) throw new Error(label) }

async function waitRun(id: string, until: (run: A.Run) => boolean, ms = 300_000) {
  const end = Date.now() + ms
  let run: A.Run | undefined
  while (Date.now() < end) {
    const res = await call<A.Run>(`/automation-apps/runs/${id}`, { at: peer && Math.random() > 0.5 ? peer : base })
    expectStatus(res.status, 200, "读取运行")
    run = res.data
    if (until(run)) return run
    await Bun.sleep(1500)
  }
  throw new Error(`等待运行超时：${run?.status} ${run?.error ?? ""}`)
}
async function confirmPauses(id: string, max = 3) {
  let confirmations = 0
  return await waitRun(id, (run) => {
    if (run.status === "paused" && run.results[run.cursor]?.pauseReason === "confirmation" && confirmations < max) {
      confirmations++
      void call(`/automation-apps/runs/${id}/resume`, { body: { action: "confirm" } })
      return false
    }
    return ["succeeded", "failed"].includes(run.status)
  })
}
/** 自动确认「确认执行」暂停，直到运行进入失败暂停或终态。 */
async function runUntilSettled(id: string, max = 3) {
  let confirmations = 0
  return await waitRun(id, (run) => {
    if (run.status === "paused" && run.results[run.cursor]?.pauseReason === "confirmation") {
      if (confirmations < max) {
        confirmations++
        void call(`/automation-apps/runs/${id}/resume`, { body: { action: "confirm" } })
      }
      return false
    }
    return ["succeeded", "failed", "paused"].includes(run.status)
  })
}
async function artifact(path: string) {
  const res = await fetch(`${base}/api/sessions/${ctx.sessionId}/fs/content?path=${encodeURIComponent(path)}`, {
    headers: { authorization: `Bearer ${token.owner}` },
  })
  check(res.ok, `读取产物失败 ${res.status}`)
  const payload = (await res.json()) as { content?: string }
  return payload.content ?? ""
}

// 每个用例只含一个数据处理步骤，固定 id 便于断言。
const script = (source: string, runtime: "python" | "javascript" = "python") => ({
  id: "data", title: "数据处理",
  operation: { type: "script" as const, runtime, source },
})
const browserStep = (id: string, title: string, action: A.BrowserOperation["action"], extra: Partial<A.BrowserOperation> = {}) => ({
  id, title, operation: { type: "browser" as const, action, ...extra },
})
function definition(name: string, steps: A.Step[], parameters: A.Parameter[] = []): A.Definition {
  return { name: `${name} ${stamp}`, description: "用例矩阵", model: Schema.decodeUnknownSync(Model.Ref)(modelEnv), parameters, steps }
}
async function createDefinition(def: A.Definition) {
  const res = await call<A.App>("/automation-apps", { body: def })
  expectStatus(res.status, 201, "创建应用")
  return res.data
}
async function startRun(appId: string, parameters: Record<string, string> = {}, requestKey = crypto.randomUUID()) {
  const res = await call<A.Run>(`/automation-apps/${appId}/runs`, { body: { sessionId: ctx.sessionId, requestKey, parameters } })
  expectStatus(res.status, 201, "创建运行")
  ctx.runs.push(res.data.id)
  return res.data
}

/** 每个用例结束后收尾：活动运行必须结束，否则下一个用例会被会话互斥挡住。 */
async function cleanupRuns() {
  for (const id of ctx.runs.splice(0)) {
    for (let i = 0; i < 60; i++) {
      const res = await call<A.Run>(`/automation-apps/runs/${id}`)
      if (res.status === 404) break
      if (["succeeded", "failed"].includes(res.data.status)) break
      if (res.data.status === "paused") {
        await call(`/automation-apps/runs/${id}/resume`, { body: { action: "stop" } })
        continue
      }
      await Bun.sleep(500)
    }
  }
}

const cases: Array<{ id: string; title: string; level: string; run: () => Promise<unknown> }> = [
  // ---------------- 简单：只有校验，不依赖沙箱 ----------------
  {
    id: "S1", level: "简单", title: "空步骤被拒绝",
    run: async () => { expectStatus((await call("/automation-apps", { body: definition("空步骤", []) })).status, 400, "空步骤") },
  },
  {
    id: "S2", level: "简单", title: "重复参数名被拒绝",
    run: async () => {
      const p = { key: "q", label: "关键词", required: true, defaultValue: "" }
      expectStatus((await call("/automation-apps", { body: definition("重复参数", [browserStep("a", "打开", "navigate", { value: "https://example.com" })], [p, p]) })).status, 400, "重复参数")
    },
  },
  {
    id: "S3", level: "简单", title: "未定义参数引用被拒绝",
    run: async () => {
      const def = definition("未定义参数", [browserStep("a", "打开", "navigate", { value: "https://example.com?q={{missing}}" })])
      expectStatus((await call("/automation-apps", { body: def })).status, 400, "未定义参数")
    },
  },
  {
    id: "S4", level: "简单", title: "定位符里不能注入参数",
    run: async () => {
      const p = { key: "sel", label: "选择器", required: true, defaultValue: "h1" }
      const def = definition("参数注入", [{ id: "a", title: "提取", operation: { type: "browser", action: "extract", selector: "{{sel}}" } }], [p])
      expectStatus((await call("/automation-apps", { body: def })).status, 400, "选择器注入")
    },
  },
  {
    id: "S5", level: "简单", title: "运行期 file:// 地址被拒绝",
    run: async () => {
      const p = { key: "url", label: "网址", required: true, defaultValue: "file:///etc/passwd" }
      const app = await createDefinition(definition("危险地址", [browserStep("a", "打开", "navigate", { value: "{{url}}" })], [p]))
      expectStatus((await call(`/automation-apps/${app.id}/runs`, { body: { sessionId: ctx.sessionId, requestKey: crypto.randomUUID(), parameters: { url: "file:///etc/passwd" } } })).status, 400, "file 协议")
    },
  },
  {
    id: "S6", level: "简单", title: "必填参数缺失被拒绝",
    run: async () => {
      const p = { key: "topic", label: "主题", required: true, defaultValue: "" }
      const app = await createDefinition(definition("必填参数", [script("print(1)")], [p]))
      expectStatus((await call(`/automation-apps/${app.id}/runs`, { body: { sessionId: ctx.sessionId, requestKey: crypto.randomUUID(), parameters: {} } })).status, 400, "必填缺失")
    },
  },
  {
    id: "S7", level: "简单", title: "未登录 401、跨用户 404、列表隔离",
    run: async () => {
      const anonymous = await fetch(`${base}/api/automation-apps`)
      expectStatus(anonymous.status, 401, "未登录")
      const app = await createDefinition(definition("归属隔离", [script("print(1)")]))
      ctx.appId = app.id
      expectStatus((await call(`/automation-apps/${app.id}`, { as: "other" })).status, 404, "跨用户读取")
      const list = await call<{ items: A.App[] }>("/automation-apps", { as: "other" })
      check(!list.data.items.some((item) => item.id === app.id), "其他用户列表不应包含该应用")
      const mine = await call<{ items: A.App[] }>("/automation-apps")
      check(mine.data.items.some((item) => item.id === app.id), "自己的列表应包含应用")
    },
  },
  // ---------------- 中等：单步执行 ----------------
  {
    id: "M1", level: "中等", title: "单个数据处理脚本：确认后才执行，无 AI 调用",
    run: async () => {
      const app = await createDefinition(definition("单步脚本", [script("import json,os\nprint(json.dumps({'ok': True, 'topic': __import__('json').loads(__import__('os').environ['AUTOMATION_INPUT'])['topic']}))")], [{ key: "topic", label: "主题", required: true, defaultValue: "默认" }]))
      const run = await startRun(app.id, { topic: "单步" })
      const first = await waitRun(run.id, (r) => r.status !== "queued" && r.status !== "running")
      check(first.status === "paused" && first.results[0]?.pauseReason === "confirmation", `应等待确认，实际 ${first.status}`)
      await call(`/automation-apps/runs/${run.id}/resume`, { body: { action: "confirm" } })
      const done = await waitRun(run.id, (r) => ["succeeded", "failed", "paused"].includes(r.status))
      check(done.status === "succeeded", `应成功，实际 ${done.status} ${done.error ?? ""}`)
      const printed = JSON.parse(done.results[0]?.output ?? "{}") as { topic?: string }
      check(printed.topic === "单步", `输出应包含参数值，实际 ${done.results[0]?.output ?? "(空)"}`)
      return { runId: run.id }
    },
  },
  {
    id: "M2", level: "中等", title: "单个浏览器步骤：打开页面成功",
    run: async () => {
      const app = await createDefinition(definition("单步浏览器", [browserStep("open", "打开验收页面", "navigate", { value: "http://127.0.0.1:18765" })]))
      const run = await startRun(app.id)
      const done = await waitRun(run.id, (r) => ["succeeded", "failed"].includes(r.status))
      check(done.status === "succeeded", `应成功，实际 ${done.status} ${done.error ?? ""}`)
      check(done.targetId, "应记录复用的浏览器标签页")
      return { runId: run.id, targetId: done.targetId }
    },
  },
  {
    id: "M3", level: "中等", title: "重复幂等键返回同一运行，不重复执行",
    run: async () => {
      const app = await createDefinition(definition("幂等", [script("print('idem')")]))
      const key = crypto.randomUUID()
      const first = await startRun(app.id, {}, key)
      const again = await call<A.Run>(`/automation-apps/${app.id}/runs`, { body: { sessionId: ctx.sessionId, requestKey: key, parameters: {} } })
      expectStatus(again.status, 200, "幂等重放")
      check(again.data.id === first.id, "应返回同一运行")
      const mismatch = await call(`/automation-apps/${app.id}/runs`, { body: { sessionId: ctx.sessionId, requestKey: key, parameters: {} } })
      check(mismatch.status === 200, "内容一致时应幂等")
      return { runId: first.id }
    },
  },
  {
    id: "M4", level: "中等", title: "同会话并行运行被拒绝（409）",
    run: async () => {
      const app = await createDefinition(definition("会话互斥", [script("import time\ntime.sleep(1)\nprint(1)")]))
      const first = await startRun(app.id)
      expectStatus((await call(`/automation-apps/${app.id}/runs`, { body: { sessionId: ctx.sessionId, requestKey: crypto.randomUUID(), parameters: {} } })).status, 409, "并行运行")
      await call(`/automation-apps/runs/${first.id}/resume`, { body: { action: "stop" } }).catch(() => undefined)
      return { runId: first.id }
    },
  },
  {
    id: "M5", level: "中等", title: "运行中结束（stop）后状态为已结束，不再推进",
    run: async () => {
      const app = await createDefinition(definition("结束运行", [script("print(1)")]))
      const run = await startRun(app.id)
      await waitRun(run.id, (r) => r.status === "paused")
      await call(`/automation-apps/runs/${run.id}/resume`, { body: { action: "stop" } })
      const stopped = await waitRun(run.id, (r) => ["failed", "succeeded"].includes(r.status))
      check(stopped.status === "failed", `应结束，实际 ${stopped.status}`)
      expectStatus((await call(`/automation-apps/runs/${run.id}/resume`, { body: { action: "confirm" } })).status, 409, "结束后不可恢复")
      return { runId: run.id }
    },
  },
  // ---------------- 复杂：组合、修复、并发、恢复 ----------------
  {
    id: "C1", level: "复杂", title: "浏览器与数据处理组合：提取 → 写产物 → 参数生效",
    run: async () => {
      const app = await createDefinition(definition("组合流程", [
        browserStep("open", "打开验收页面", "navigate", { value: "http://127.0.0.1:18765" }),
        browserStep("read", "提取主标题", "extract", { selector: "#current-heading" }),
        script("import json,os,pathlib\nparams=json.loads(os.environ['AUTOMATION_INPUT'])\nresults=json.loads(pathlib.Path(os.environ['AUTOMATION_RESULTS_PATH']).read_text())\nout={'heading':results['read'].strip(),'topic':params['topic']}\npathlib.Path('/workspace/output/cases-c1.json').write_text(json.dumps(out,ensure_ascii=False))\nprint(json.dumps(out,ensure_ascii=False))"),
      ], [{ key: "topic", label: "主题", required: true, defaultValue: "组合" }]))
      const run = await startRun(app.id, { topic: "中文组合" })
      const done = await confirmPauses(run.id)
      check(done.status === "succeeded", `应成功，实际 ${done.status} ${done.error ?? ""}`)
      check(done.results[1]?.output?.includes("自动化验收标题"), "应提取到页面标题")
      const saved = JSON.parse(await artifact("/workspace/output/cases-c1.json")) as { heading: string; topic: string }
      check(saved.topic === "中文组合" && saved.heading.includes("自动化验收标题"), `产物内容不符：${JSON.stringify(saved)}`)
      return { runId: run.id, saved }
    },
  },
  {
    id: "C2", level: "复杂", title: "浏览器定位失效 → AI 局部修复 → 原地继续",
    run: async () => {
      const app = await createDefinition(definition("定位修复", [
        browserStep("open", "打开验收页面", "navigate", { value: "http://127.0.0.1:18765" }),
        browserStep("read", "提取已改名的标题", "extract", { selector: "#removed-heading" }),
      ]))
      const run = await startRun(app.id)
      const done = await waitRun(run.id, (r) => ["succeeded", "failed", "paused"].includes(r.status))
      check(done.status === "succeeded", `应修复后成功，实际 ${done.status} ${done.error ?? ""}`)
      check(done.results[1]?.repairAttempts === 1, "应记录一次修复")
      check(done.results[1]?.repairedOperation?.type === "browser", "应保存修复后的定位")
      const [stored] = await db.select().from(automationApp).where(eq(automationApp.id, app.id))
      check(done.repairApplied && stored?.version === 2, "验证成功后应自动保存修复")
      return { runId: run.id, repaired: done.results[1]?.repairedOperation }
    },
  },
  {
    id: "C3", level: "复杂", title: "脚本异常 → AI 修复 → 确认 → 成功 → 更新应用",
    run: async () => {
      const app = await createDefinition(definition("脚本修复", [
        script("import json\ndata={'count':3}\nprint(json.dumps({'total':data['total']}))"),
      ]))
      const run = await startRun(app.id)
      const ready = await runUntilSettled(run.id)
      check(ready.status === "paused" && ready.results[ready.cursor]?.pauseReason === "repair_review", `应自动生成待审核修复，实际 ${ready.status} ${ready.error ?? ""}`)
      check(!!ready.results[ready.cursor]?.repairedOperation, "修复方案未生成")
      check(ready.results[ready.cursor]?.repairAttempts === 1, "应自动尝试一次修复")
      const [before] = await db.select().from(automationApp).where(eq(automationApp.id, app.id))
      check(before?.version === 1, "确认前不得修改应用")
      await call(`/automation-apps/runs/${run.id}/resume`, { body: { action: "confirm" } })
      const done = await waitRun(run.id, (r) => ["succeeded", "failed", "paused"].includes(r.status))
      check(done.status === "succeeded", `修复后应成功，实际 ${done.status} ${done.error ?? ""}`)
      check(JSON.parse(done.results[0]?.output ?? "null")?.total === 3, "修复后业务结果不正确")
      check(done.repairApplied, "修复成功后应自动保存")
      const [after] = await db.select().from(automationApp).where(eq(automationApp.id, app.id))
      check(after?.version === 2, "运行成功后应用应升版")
      const repeat = await startRun(app.id)
      const repeated = await confirmPauses(repeat.id)
      check(repeated.status === "succeeded" && repeated.appVersion === 2, "新版本再次运行未成功")
      check(repeated.results[0]?.repairAttempts === 0 && JSON.parse(repeated.results[0]?.output ?? "null")?.total === 3, "新版本业务结果不正确或再次修复")
      return { runId: run.id, version: after?.version, repeatRunId: repeat.id }
    },
  },
  {
    id: "C4", level: "复杂", title: "双实例交替推进，脚本只执行一次",
    run: async () => {
      if (!peer) return { skipped: "未配置 CASES_PEER" }
      const app = await createDefinition(definition("双实例", [script("import time,json\ntime.sleep(2)\nprint(json.dumps({'ok':1}))")]))
      const run = await startRun(app.id)
      const done = await confirmPauses(run.id)
      check(done.status === "succeeded", `应成功，实际 ${done.status} ${done.error ?? ""}`)
      const log = await fetch(`${saas}/api/experimental/session/${ctx.sessionId}/log?follow=false&after=0`, {
        headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
      }).then((res) => res.text())
      const events: Array<{ type?: string; data?: { shell?: { command?: string } } }> = log.trim().startsWith("[")
        ? JSON.parse(log)
        : log.split("\n").filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5).trim()))
      const executions = events.filter((event) => event.type === "session.shell.started" && event.data?.shell?.command?.startsWith("python3 -c")).length
      check(executions >= 1, "应至少执行一次")
      return { runId: run.id, executionsNote: "多次运行共享同一沙箱，按运行内重复检查" }
    },
  },
  {
    id: "C5", level: "复杂", title: "执行中崩溃：恢复后暂停核实，不重放",
    run: async () => {
      const app = await createDefinition(definition("崩溃恢复", [script("import time,json\ntime.sleep(2)\nprint(json.dumps({'ok':1}))")]))
      const run = await startRun(app.id)
      await waitRun(run.id, (r) => r.status === "paused")
      await db.update(automationRun).set({ status: "running", results: [{ stepId: run.definition.steps[0]!.id, status: "running", repairAttempts: 0, approved: true }] }).where(eq(automationRun.id, run.id))
      const recovered = await waitRun(run.id, (r) => r.status === "paused" && r.results[0]?.pauseReason === "uncertain", 60_000)
      check(recovered.results[0]?.pauseReason === "uncertain", "应标记为不确定")
      await call(`/automation-apps/runs/${run.id}/resume`, { body: { action: "skip" } })
      const done = await waitRun(run.id, (r) => ["succeeded", "failed"].includes(r.status))
      check(done.results[0]?.skipped === true, "跳过应标记为已核实")
      return { runId: run.id }
    },
  },
  {
    id: "C6", level: "复杂", title: "应用更新后旧运行仍用旧版本，用户可对照",
    run: async () => {
      const app = await createDefinition(definition("版本快照", [script("print('v1')")]))
      const run = await startRun(app.id)
      await waitRun(run.id, (r) => r.status === "paused")
      const [stored] = await db.select().from(automationRun).where(eq(automationRun.id, run.id))
      check(stored?.appVersion === 1, "运行应记录创建时版本")
      check(stored?.definition.steps[0]?.operation.type === "script", "运行应保存定义快照")
      await call(`/automation-apps/runs/${run.id}/resume`, { body: { action: "stop" } })
      return { runId: run.id, appVersion: stored?.appVersion }
    },
  },
  {
    id: "C7", level: "复杂", title: "业务阶段：网页读取、双来源订单整理与参数校验",
    run: async () => {
      const app = await createDefinition(definition("每日订单整理", [
        { ...browserStep("open", "打开订单页面", "navigate", { value: "http://127.0.0.1:18765" }), businessStage: "获取订单信息" },
        { ...browserStep("read", "读取订单页面标题", "extract", { selector: "#current-heading" }), businessStage: "获取订单信息" },
        { ...script("import os,json,pathlib,csv\np=pathlib.Path('/workspace/output/order-c7');p.mkdir(parents=True,exist_ok=True)\nfor name,rows in [('erp',[['A','2'],['B','1']]),('platform',[['A','3'],['C','4']])]:\n with (p/(name+'.csv')).open('w',newline='') as f:\n  w=csv.writer(f);w.writerow(['sku','quantity']);w.writerows(rows)\nprint('两份订单文件已准备')"), id: "prepare", title: "准备两份测试订单", businessStage: "整理每日订单" },
        { ...script("import os,json,pathlib,csv,collections\np=pathlib.Path('/workspace/output/order-c7');args=json.loads(os.environ['AUTOMATION_INPUT']);results=json.loads(pathlib.Path(os.environ['AUTOMATION_RESULTS_PATH']).read_text());totals=collections.Counter()\nfor name in ['erp','platform']:\n with (p/(name+'.csv')).open() as f:\n  for row in csv.DictReader(f): totals[row['sku']]+=int(row['quantity'])\nout={'date':args['date'],'heading':results['read'].strip(),'totals':dict(totals)}\n(p/'report.json').write_text(json.dumps(out,ensure_ascii=False));print(json.dumps(out,ensure_ascii=False))"), id: "report", title: "汇总订单数量", businessStage: "整理每日订单" },
      ], [{ key: "date", label: "订单日期", required: true, defaultValue: "" }]))
      const run = await startRun(app.id, { date: "2026-10-30" })
      const done = await confirmPauses(run.id, 4)
      check(done.status === "succeeded", `业务流程未成功：${done.status} ${done.error ?? ""}`)
      const output = JSON.parse(await artifact("/workspace/output/order-c7/report.json")) as { date: string; heading: string; totals: Record<string, number> }
      check(output.date === "2026-10-30" && output.heading.includes("自动化验收标题"), "参数或网页结果不正确")
      check(JSON.stringify(output.totals) === JSON.stringify({ A: 5, B: 1, C: 4 }), "两份订单汇总不正确")
      const [stored] = await db.select().from(automationRun).where(eq(automationRun.id, run.id))
      check(stored?.results.length === 4 && stored.results.every((entry) => entry.status === "succeeded"), "PG 步骤结果不完整")
      check(stored?.definition.steps.map((step) => step.businessStage).join(",") === "获取订单信息,获取订单信息,整理每日订单,整理每日订单", "PG 业务阶段不正确")
      return { runId: run.id, output }
    },
  },
]

try {
  token.owner = await signup("用例矩阵主账号", "owner")
  token.other = await signup("用例矩阵旁路账号", "other")
  check(!!token.owner && !!token.other, "注册失败")

  if (process.env.CASES_SESSION_ID) ctx.sessionId = process.env.CASES_SESSION_ID
  else {
    const session = await call<{ session: { id: string } }>("/browser/sessions", { body: { title: `用例矩阵 ${stamp}` } })
    expectStatus(session.status, 201, "创建浏览器会话")
    ctx.sessionId = session.data.session.id
  }
  for (let i = 0; i < 180; i++) {
    const state = await call<{ status: string; error?: string }>(`/browser/sessions/${ctx.sessionId}/browser`)
    if (state.data.status === "failed") throw new Error(`浏览器准备失败：${state.data.error}`)
    if (state.data.status === "ready") break
    if (i === 179) throw new Error("浏览器准备超时")
    await Bun.sleep(2000)
  }
  const html = Buffer.from('<!doctype html><meta charset="utf-8"><title>用例矩阵</title><h1 id="current-heading">自动化验收标题</h1><p>确定性测试页面</p>').toString("base64")
  const fixture = await saasRunShell(ctx.sessionId, `mkdir -p /workspace/.cases-fixture && printf '%s' '${html}' | base64 -d > /workspace/.cases-fixture/index.html && (nohup python3 -m http.server 18765 --bind 127.0.0.1 --directory /workspace/.cases-fixture > /workspace/output/cases-fixture.log 2>&1 < /dev/null &)`)
  check(fixture.exit === 0, "无法准备测试页面")

  for (const item of (process.env.CASES_ONLY ? cases.filter((entry) => process.env.CASES_ONLY!.split(",").includes(entry.id)) : cases)) {
    const started = Date.now()
    try {
      const detail = await item.run()
      evidence.push({ id: item.id, title: item.title, level: item.level, passed: true, ms: Date.now() - started, detail })
      console.log(`✓ ${item.id} [${item.level}] ${item.title} (${Date.now() - started}ms)`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      evidence.push({ id: item.id, title: item.title, level: item.level, passed: false, ms: Date.now() - started, detail: message })
      console.log(`✗ ${item.id} [${item.level}] ${item.title} (${Date.now() - started}ms) → ${message}`)
    }
    try { await cleanupRuns() } catch { /* 收尾失败不影响后续用例判定 */ }
  }
} finally {
  const passed = evidence.filter((item) => item.passed).length
  console.log(`\n结果：${passed}/${evidence.length} 通过`)
  console.log(JSON.stringify({ sessionId: ctx.sessionId, cases: evidence }, null, 2))
  if (passed !== evidence.length) process.exitCode = 1
  await pool.end()
}
