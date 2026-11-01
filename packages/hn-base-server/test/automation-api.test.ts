import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { and, eq, inArray } from "drizzle-orm"
import type { AutomationApp as A } from "@opencode/schema/automation-app"
import { createApp } from "../src/app"
import { db, pool } from "../src/db"
import { ensureSchema } from "../src/db/ensure-schema"
import { automationApp, automationRun, auditLog, relationTuple, user } from "../src/db/schema"
import { env } from "../src/config/env"
import { writeTuples } from "../src/authz"
import { processAutomationRun } from "../src/lib/automation-worker"

const app = createApp()
const prefix = `auto_${crypto.randomUUID()}`
const userIds: string[] = [],
  appIds: string[] = [],
  sessionIds: string[] = []
let owner = "",
  other = "",
  upstream: ReturnType<typeof Bun.serve>
const previousUrl = process.env.OPENCODE_SAAS_URL
const commands = new Map<string, string>()
const prompts = new Map<string, { id: string; text: string; permissions: unknown }>()
const browserActions: string[] = []
let disconnectNext = false
let scriptCalls = 0,
  promptCalls = 0,
  failScript = false
const value: A.Definition = {
  name: "汇总数据",
  description: "固定数据处理",
  parameters: [{ key: "text", label: "文本", required: true, defaultValue: "" }],
  steps: [{ id: "data", title: "整理为报告", operation: { type: "script", runtime: "python", source: "print('ok')" } }],
}
function request(path: string, method = "GET", body?: unknown, token = owner) {
  return app.request(`/api/automation-apps${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}
async function login(name: string) {
  const res = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: env.webOrigin },
    body: JSON.stringify({ name, email: `${prefix}_${name}@example.com`, password: "ab123456" }),
  })
  expect(res.status).toBe(200)
  userIds.push(((await res.json()) as { user: { id: string } }).user.id)
  return res.headers.get("set-auth-token")!
}
async function create(definition = value) {
  const res = await request("", "POST", definition)
  expect(res.status).toBe(201)
  const result = (await res.json()) as A.App
  appIds.push(result.id)
  return result
}
async function session() {
  const id = `ses_${crypto.randomUUID().replaceAll("-", "")}`
  sessionIds.push(id)
  await writeTuples(db, [
    { resourceType: "session", resourceId: id, relation: "owner", subjectType: "user", subjectId: userIds[0]! },
  ])
  return id
}
async function start(id: string, sessionId = "", requestKey = crypto.randomUUID()) {
  return request(`/${id}/runs`, "POST", {
    sessionId: sessionId || (await session()),
    requestKey,
    parameters: { text: "中文参数" },
  })
}
async function status(id: string) {
  return (await (await request(`/runs/${id}`)).json()) as A.Run
}
beforeAll(async () => {
  if (env.databaseSchema === "hn_base") throw new Error("必须使用独立 BASE_DATABASE_SCHEMA")
  await ensureSchema(pool)
  upstream = Bun.serve({
    port: 0,
    websocket: {
      message(ws, raw) {
        const message = JSON.parse(String(raw))
        if (disconnectNext) {
          disconnectNext = false
          ws.close()
          return
        }
        browserActions.push(message.method)
        let result: unknown = {}
        if (message.method === "Runtime.evaluate") {
          const expression = String(message.params.expression)
          result = {
            result: {
              value: expression.includes("elements:Array.from")
                ? JSON.stringify({
                    url: "https://example.com",
                    elements: [{ tag: "H1", id: "fixed", text: "网页数据" }],
                  })
                : expression.includes('"selector":"#missing"')
                  ? { missing: true, error: "定位已变化" }
                  : { output: "网页数据" },
            },
          }
        }
        ws.send(JSON.stringify({ id: message.id, result }))
      },
    },
    async fetch(req, server) {
      const url = new URL(req.url),
        id = url.pathname.split("/")[3]!
      if (url.pathname.includes("/devtools/page/")) {
        server.upgrade(req, { data: undefined })
        return
      }
      if (url.pathname === "/api/session" && req.method === "POST")
        return Response.json({ data: { id: `ses_ai_${crypto.randomUUID().replaceAll("-", "")}` } })
      if (url.pathname.endsWith("/prompt")) {
        promptCalls++
        prompts.set(id, (await req.json()) as { id: string; text: string; permissions: unknown })
        return Response.json({})
      }
      if (url.pathname.endsWith("/message")) {
        const prompt = prompts.get(id)
        return Response.json({
          data: prompt
            ? [
                {
                  type: "assistant",
                  promptMessageID: prompt.id,
                  structured: prompt.text.includes("修复这一个固定")
                    ? { type: "script", runtime: "python", source: "print('fixed')" }
                  : prompt.text.includes("将以下已经")
                    ? { status: "ready", reason: "", ...value }
                      : { selector: "#fixed", reason: "页面定位变化" },
                },
              ]
            : [],
        })
      }
      if (url.pathname.endsWith("/agents-md")) return Response.json({ data: { content: "browser" } })
      if (url.pathname.endsWith("/json/version")) return Response.json({ Browser: "Chromium", webSocketDebuggerUrl: "ws://127.0.0.1/devtools/browser/test" })
      if (url.pathname.endsWith("/json/list"))
        return Response.json([{ id: "PAGE_A", type: "page", url: "https://example.com", title: "示例" }])
      if (url.pathname.endsWith("/shell")) {
        const body = (await req.json()) as { command: string }
        commands.set(id, body.command)
        if (body.command.startsWith("python3 -c")) scriptCalls++
        await new Promise((resolve) => setTimeout(resolve, 25))
        return Response.json({})
      }
      if (url.pathname.endsWith("/log")) {
        const sid = url.pathname.split("/")[4]!
        const failed = failScript && commands.get(sid)?.startsWith("python3 -c")
        return Response.json([
          {
            type: "session.shell.ended",
            data: {
              shell: { command: commands.get(sid), exit: failed ? 1 : 0 },
              output: {
                output: commands.get(sid)?.includes("PROBE_DONE")
                  ? "SCRIPT=/opt/cdp-browser/cdp-browser.sh\nFLOCK=1"
                  : failed
                    ? "partial write"
                    : "汇总完成",
              },
            },
          },
        ])
      }
      return Response.json({ data: [] })
    },
  })
  process.env.OPENCODE_SAAS_URL = `http://127.0.0.1:${upstream.port}`
  owner = await login("owner")
  other = await login("other")
})
afterAll(async () => {
  if (previousUrl === undefined) delete process.env.OPENCODE_SAAS_URL
  else process.env.OPENCODE_SAAS_URL = previousUrl
  upstream?.stop(true)
  if (appIds.length) {
    await db.delete(automationRun).where(inArray(automationRun.appId, appIds))
    await db.delete(automationApp).where(inArray(automationApp.id, appIds))
  }
  if (sessionIds.length) await db.delete(relationTuple).where(inArray(relationTuple.resourceId, sessionIds))
  if (userIds.length) {
    await db.delete(auditLog).where(inArray(auditLog.actorId, userIds))
    await db.delete(user).where(inArray(user.id, userIds))
  }
})

describe("自动化 HTTP + 真实 PG + 模拟 SaaS", () => {
  test("业务阶段随应用和运行快照保存，底层动作顺序不变", async () => {
    const item = await create({
      ...value,
      steps: [
        { id: "open", title: "打开订单页", businessStage: "查询订单", operation: { type: "browser", action: "navigate", value: "https://example.com" } },
        { id: "read", title: "读取订单", businessStage: "查询订单", operation: { type: "browser", action: "extract", selector: "h1" } },
        { id: "data", title: "生成报表", businessStage: "整理订单", operation: { type: "script", runtime: "python", source: "print('ok')" } },
      ],
    })
    const run = (await (await start(item.id)).json()) as A.Run
    expect(run.definition.steps.map((step) => [step.id, step.businessStage])).toEqual([
      ["open", "查询订单"], ["read", "查询订单"], ["data", "整理订单"],
    ])
    const [stored] = await db.select().from(automationRun).where(eq(automationRun.id, run.id))
    expect(stored?.definition).toEqual(run.definition)
  })
  test("未登录拒绝；应用归属隔离；无效定义与参数拒绝", async () => {
    expect((await app.request("/api/automation-apps")).status).toBe(401)
    const item = await create()
    expect((await request(`/${item.id}`, "GET", undefined, other)).status).toBe(404)
    expect(((await (await request("", "GET", undefined, other)).json()) as { items: A.App[] }).items).toEqual([])
    expect((await request("", "POST", { ...value, steps: [] })).status).toBe(400)
    expect(
      (
        await request(`/${item.id}/runs`, "POST", {
          sessionId: await session(),
          requestKey: crypto.randomUUID(),
          parameters: {},
        })
      ).status,
    ).toBe(400)
    expect((await start(item.id, "ses_foreign")).status).toBe(404)
  })
  test("读取探索记录生成应用草稿，并继承探索会话的模型", async () => {
    const sid = await session()
    const res = await request("/draft", "POST", { sessionId: sid })
    expect(res.status).toBe(200)
    const draft = await res.json() as { definition: A.Definition }
    expect(draft.definition.name).toBe(value.name)
    expect([...prompts.values()].at(-1)?.permissions).toEqual([{ action: "*", resource: "*", effect: "deny" }])
    expect((await request("/draft", "POST", { sessionId: sid }, other)).status).toBe(404)
  })
  test("固定脚本先确认；多实例只执行一次；不调用 AI；PG 检查点一致", async () => {
    const item = await create(),
      sid = await session()
    const run = (await (await start(item.id, sid)).json()) as A.Run
    const before = scriptCalls,
      beforePrompts = promptCalls
    await processAutomationRun(run.id)
    expect((await status(run.id)).status).toBe("paused")
    expect(scriptCalls).toBe(before)
    expect((await request(`/runs/${run.id}/resume`, "POST", { action: "confirm" }, other)).status).toBe(404)
    expect((await request(`/runs/${run.id}/resume`, "POST", { action: "confirm" })).status).toBe(200)
    await Promise.all([processAutomationRun(run.id), processAutomationRun(run.id)])
    const done = await status(run.id)
    expect(done.status).toBe("succeeded")
    expect(done.cursor).toBe(1)
    expect(done.results[0]?.output).toBe("汇总完成")
    expect(scriptCalls - before).toBe(1)
    expect(promptCalls).toBe(beforePrompts)
    const [stored] = await db.select().from(automationRun).where(eq(automationRun.id, run.id))
    expect(stored?.definition).toEqual(value)
    expect(stored?.parameters).toEqual({ text: "中文参数" })
    expect((await request(`/runs/${run.id}/resume`, "POST", { action: "confirm" })).status).toBe(409)
  })
  test("重复请求幂等；同会话不能并行运行；请求内容变化不能复用幂等键", async () => {
    const item = await create(),
      sid = await session(),
      key = crypto.randomUUID()
    const first = await start(item.id, sid, key),
      run = (await first.json()) as A.Run
    expect(first.status).toBe(201)
    expect(((await (await start(item.id, sid, key)).json()) as A.Run).id).toBe(run.id)
    expect((await start(item.id, sid)).status).toBe(409)
    expect((await start(item.id, await session(), key)).status).toBe(409)
    const concurrentSid = await session(),
      concurrentKey = crypto.randomUUID()
    const concurrent = await Promise.all([
      start(item.id, concurrentSid, concurrentKey),
      start(item.id, concurrentSid, concurrentKey),
    ])
    expect(concurrent.map((r) => r.status).sort()).toEqual([200, 201])
    const bodies = await Promise.all(concurrent.map(async (r) => (await r.json()) as A.Run))
    expect(bodies[0].id).toBe(bodies[1].id)
  })
  test("进程退出后的 in-flight 步骤暂停，不重放；可核实跳过", async () => {
    const item = await create(),
      run = (await (await start(item.id)).json()) as A.Run
    await db
      .update(automationRun)
      .set({ status: "running", results: [{ stepId: "data", status: "running", repairAttempts: 0 }] })
      .where(eq(automationRun.id, run.id))
    const before = scriptCalls
    await processAutomationRun(run.id)
    expect((await status(run.id)).results[0]?.pauseReason).toBe("uncertain")
    expect(scriptCalls).toBe(before)
    await request(`/runs/${run.id}/resume`, "POST", { action: "skip" })
    await processAutomationRun(run.id)
    expect((await status(run.id)).status).toBe("succeeded")
    expect(scriptCalls).toBe(before)
  })
  test("失败脚本自动生成修复，但可能部分成功，确认前不自动重试", async () => {
    const item = await create(),
      run = (await (await start(item.id)).json()) as A.Run
    await processAutomationRun(run.id)
    await request(`/runs/${run.id}/resume`, "POST", { action: "confirm" })
    failScript = true
    try {
      await processAutomationRun(run.id)
    } finally {
      failScript = false
    }
    const repairing = await status(run.id),
      before = scriptCalls
    expect(repairing.status).toBe("repairing")
    expect(repairing.results[0]?.error).toContain("partial write")
    await processAutomationRun(run.id)
    const paused = await status(run.id)
    expect(paused.status).toBe("paused")
    expect(paused.results[0]?.pauseReason).toBe("repair_review")
    expect([...prompts.values()].at(-1)?.text).toContain("partial write")
    expect(scriptCalls).toBe(before)
    await request(`/runs/${run.id}/resume`, "POST", { action: "stop" })
    expect((await status(run.id)).status).toBe("failed")
  })
  test("修复不静默覆盖；只有成功且非跳过的修复可确认更新；版本冲突保护", async () => {
    const item = await create(),
      run = (await (await start(item.id)).json()) as A.Run
    const repaired = { type: "script", runtime: "python", source: "print('fixed')" } as const
    await db
      .update(automationRun)
      .set({
        status: "succeeded",
        cursor: 1,
        results: [{ stepId: "data", status: "succeeded", repairAttempts: 1, repairedOperation: repaired }],
      })
      .where(eq(automationRun.id, run.id))
    const [unchanged] = await db.select().from(automationApp).where(eq(automationApp.id, item.id))
    expect(unchanged?.version).toBe(1)
    const responses = await Promise.all([
      request(`/runs/${run.id}/apply-repair`, "POST"),
      request(`/runs/${run.id}/apply-repair`, "POST"),
    ])
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409])
    const [updated] = await db.select().from(automationApp).where(eq(automationApp.id, item.id))
    expect(updated?.version).toBe(2)
    expect(updated?.definition.steps[0]?.operation).toEqual(repaired)
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.resourceId, item.id), eq(auditLog.action, "automation.apply_repair")))
    expect(audit).toBeDefined()
  })
  test("网页固定执行、局部定位修复和原地继续；修复保留模板参数", async () => {
    const browserDefinition: A.Definition = {
      ...value,
      steps: [
        {
          id: "open",
          title: "打开页面",
          operation: { type: "browser", action: "navigate", value: "https://example.com" },
        },
        {
          id: "fill",
          title: "填写关键词",
          operation: { type: "browser", action: "fill", selector: "#missing", value: "{{text}}" },
        },
        { id: "send", title: "点击查询", operation: { type: "browser", action: "click", selector: "#send" } },
        { id: "read", title: "提取信息", operation: { type: "browser", action: "extract", selector: "h1" } },
      ],
    }
    const item = await create(browserDefinition),
      run = (await (await start(item.id)).json()) as A.Run
    const beforeNavigate = browserActions.filter((m) => m === "Page.navigate").length,
      beforePrompts = promptCalls
    await processAutomationRun(run.id)
    await processAutomationRun(run.id)
    const repaired = await status(run.id)
    expect(repaired.cursor).toBe(2)
    expect(repaired.targetId).toBe("PAGE_A")
    expect(repaired.results[1]?.repairedOperation).toMatchObject({ selector: "#fixed", value: "{{text}}" })
    expect(promptCalls - beforePrompts).toBe(1)
    const prompt = [...prompts.values()].at(-1)!
    expect(prompt.permissions).toEqual([{ action: "*", resource: "*", effect: "deny" }])
    await processAutomationRun(run.id)
    expect((await status(run.id)).results[2]?.pauseReason).toBe("confirmation")
    await request(`/runs/${run.id}/resume`, "POST", { action: "confirm" })
    await processAutomationRun(run.id)
    await processAutomationRun(run.id)
    expect((await status(run.id)).status).toBe("succeeded")
    expect(browserActions.filter((m) => m === "Page.navigate").length - beforeNavigate).toBe(1)
    expect((await status(run.id)).repairApplied).toBe(true)
    expect(((await (await request(`/${item.id}`)).json()) as { app: A.App }).app.version).toBe(2)
    expect(
      ((await (await request(`/${item.id}`)).json()) as { app: A.App }).app.definition.steps[1]?.operation,
    ).toMatchObject({ value: "{{text}}" })
  }, 30_000)
  test("应用版本变化时成功运行不能覆盖新版本", async () => {
    const item = await create({ ...value, steps: [{ id: "open", title: "读取", operation: { type: "browser", action: "fill", selector: "#missing", value: "{{text}}" } }] })
    const run = (await (await start(item.id)).json()) as A.Run
    await db.update(automationApp).set({ version: 2 }).where(eq(automationApp.id, item.id))
    await processAutomationRun(run.id)
    const finished = await status(run.id)
    expect(finished.status).toBe("succeeded")
    expect(finished.repairApplied).toBe(false)
    const [app] = await db.select().from(automationApp).where(eq(automationApp.id, item.id))
    expect(app?.version).toBe(2)
    expect(app?.definition.steps[0]?.operation).toMatchObject({ selector: "#missing" })
  }, 30_000)
  test("运行跳过任一步骤时不会自动保存修复", async () => {
    const item = await create({ ...value, steps: [
      { id: "one", title: "已核实步骤", operation: { type: "browser", action: "navigate", value: "https://example.com" } },
      { id: "two", title: "读取", operation: { type: "browser", action: "extract", selector: "#old" } },
    ] })
    const run = (await (await start(item.id)).json()) as A.Run
    await db.update(automationRun).set({ cursor: 1, results: [
      { stepId: "one", status: "succeeded", skipped: true, repairAttempts: 0 },
      { stepId: "two", status: "paused", repairAttempts: 1, repairedOperation: { type: "browser", action: "extract", selector: "#fixed" } },
    ] }).where(eq(automationRun.id, run.id))
    await processAutomationRun(run.id)
    const finished = await status(run.id)
    expect(finished.status).toBe("succeeded")
    expect(finished.repairApplied).toBe(false)
    const [app] = await db.select().from(automationApp).where(eq(automationApp.id, item.id))
    expect(app?.version).toBe(1)
  })
  test("CDP 断线不调用 AI 重试；脚本修复须确认且最多两次", async () => {
    const item = await create({
      ...value,
      steps: [
        {
          id: "open",
          title: "打开页面",
          operation: { type: "browser", action: "navigate", value: "https://example.com" },
        },
      ],
    })
    const run = (await (await start(item.id)).json()) as A.Run,
      before = promptCalls
    disconnectNext = true
    await processAutomationRun(run.id)
    expect((await status(run.id)).results[0]?.pauseReason).toBe("uncertain")
    expect(promptCalls).toBe(before)
    const scriptApp = await create(),
      scriptRun = (await (await start(scriptApp.id)).json()) as A.Run
    await processAutomationRun(scriptRun.id)
    const calls = scriptCalls
    const originalError = (await status(scriptRun.id)).results[0]?.error
    const res = await request(`/runs/${scriptRun.id}/repair`, "POST")
    // 异步：登记后立即返回 202，AI 生成方案由 worker 完成，避免网关超时。
    expect(res.status).toBe(202)
    expect(((await res.json()) as A.Run).status).toBe("repairing")
    expect((await status(scriptRun.id)).results[0]?.error).toBe(originalError)
    expect((await request(`/runs/${scriptRun.id}/repair`, "POST")).status).toBe(409)
    await processAutomationRun(scriptRun.id)
    expect([...prompts.values()].at(-1)?.text).toContain(originalError!)
    const candidate = await status(scriptRun.id)
    expect(candidate.status).toBe("paused")
    expect(candidate.results[0]?.approved).toBe(false)
    expect(candidate.results[0]?.pauseReason).toBe("repair_review")
    expect(candidate.results[0]?.repairedOperation).toMatchObject({ source: "print('fixed')" })
    expect(scriptCalls).toBe(calls)
    // 修复生成后再次登记即视为新的修复轮次（上限 2 次）。
    expect((await request(`/runs/${scriptRun.id}/repair`, "POST")).status).toBe(202)
    await processAutomationRun(scriptRun.id)
    expect((await request(`/runs/${scriptRun.id}/repair`, "POST")).status).toBe(409)
  })
})
