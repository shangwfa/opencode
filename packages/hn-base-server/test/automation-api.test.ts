import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { and, eq, inArray } from "drizzle-orm"
import type { AutomationApp as A } from "@opencode/schema/automation-app"
import { createApp } from "../src/app"
import { db, pool } from "../src/db"
import { ensureSchema } from "../src/db/ensure-schema"
import { automationApp, automationDraft, automationRun, instructionApp, instructionRun, auditLog, relationTuple, user } from "../src/db/schema"
import { env } from "../src/config/env"
import { writeTuples, check } from "../src/authz"
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
type LegacyMessage = { id: string; type: string; promptMessageID?: string; time?: { completed?: number }; content?: Array<{ type: string; text: string }> }
const legacyMessages = new Map<string, LegacyMessage[]>()
const outputs = new Map<string, string>()
const browserActions: string[] = []
let disconnectNext = false
let draftFile = ""
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
      if (url.pathname.endsWith("/fs/read/.automation/draft.json")) return new Response(draftFile)
      if (url.pathname.includes("/fs/read/output/automation/")) {
        const output = outputs.get(url.pathname)
        return output === undefined ? new Response("not found", { status: 404 }) : new Response(output)
      }
      if (url.pathname.endsWith("/prompt")) {
        promptCalls++
        prompts.set(id, (await req.json()) as { id: string; text: string; permissions: unknown })
        return Response.json({})
      }
      if (url.pathname.endsWith("/message")) {
        const prompt = prompts.get(id)
        if (!prompt && legacyMessages.has(id)) {
          const all = legacyMessages.get(id)!
          const offset = Number(url.searchParams.get("cursor") ?? "0")
          return Response.json({ data: all.slice(offset, offset + 100), cursor: { next: offset + 100 < all.length ? String(offset + 100) : undefined } })
        }
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
  }
  if (sessionIds.length) await db.delete(relationTuple).where(inArray(relationTuple.resourceId, sessionIds))
  if (userIds.length) {
    const ownedDrafts = await db.select({ id: automationDraft.id }).from(automationDraft).where(inArray(automationDraft.ownerId, userIds))
    if (ownedDrafts.length) await db.delete(automationRun).where(inArray(automationRun.draftId, ownedDrafts.map((item) => item.id)))
    await db.delete(automationDraft).where(inArray(automationDraft.ownerId, userIds))
    if (appIds.length) await db.delete(automationApp).where(inArray(automationApp.id, appIds))
    await db.delete(instructionRun).where(inArray(instructionRun.ownerId, userIds))
    await db.delete(instructionApp).where(inArray(instructionApp.ownerId, userIds))
    await db.delete(auditLog).where(inArray(auditLog.actorId, userIds))
    await db.delete(user).where(inArray(user.id, userIds))
  }
})

describe("自动化 HTTP + 真实 PG + 模拟 SaaS", () => {
  test("旧应用须有成功记录才能生成幂等固定草稿，保留参数和完成标准", async () => {
    const sid = await session()
    const legacyId = `inst_${crypto.randomUUID()}`
    const sourceId = `irun_${crypto.randomUUID()}`
    const legacyDefinition = {
      name: "汇总数据", description: "原业务说明",
      parameters: value.parameters,
      instructions: [{ id: "data", title: "整理为报告", text: "读取输入并整理为报告" }],
      verification: { path: "report.json", contains: "REPORT_OK" },
    }
    await db.insert(instructionApp).values({ id: legacyId, ownerId: userIds[0]!, definition: legacyDefinition, version: 1, timeCreated: Date.now(), timeUpdated: Date.now() })
    const promptId = `msg_${crypto.randomUUID().replaceAll("-", "")}`
    await db.insert(instructionRun).values({
      id: sourceId, appId: legacyId, ownerId: userIds[0]!, sessionId: sid, requestKey: crypto.randomUUID(),
      appVersion: 1, definition: legacyDefinition, parameters: { text: "中文参数" }, promptId,
      steps: [{ index: 0, title: "整理为报告", promptId, status: "succeeded", output: "已核对报告" }],
      status: "succeeded", output: "已核对报告", timeCreated: Date.now(), timeUpdated: Date.now(),
    })
    const input = { appId: legacyId, runId: sourceId }
    expect((await request("/drafts/from-legacy", "POST", input, other)).status).toBe(404)
    expect((await request("/drafts/from-legacy", "POST", { appId: legacyId, runId: "irun_other" })).status).toBe(409)
    expect((await request("/drafts/from-legacy", "POST", input)).status).toBe(409)
    // 首屏只有无关消息，且目标 assistant 与 user 被页边界隔开。
    legacyMessages.set(sid, [
      ...Array.from({ length: 100 }, (_, index) => ({ id: `msg_unrelated_${index}`, type: "assistant" })),
      { id: `msg_answer_${promptId}`, type: "assistant", promptMessageID: promptId, time: { completed: Date.now() }, content: [{ type: "text", text: "脚本输出已核对" }] },
      { id: promptId, type: "user", content: [{ type: "text", text: "请整理" }] },
    ])
    const response = await request("/drafts/from-legacy", "POST", input)
    expect(response.status).toBe(201)
    const draft = await response.json() as A.Draft
    expect(draft.legacyAppId).toBe(legacyId)
    expect(draft.definition.parameters).toEqual(legacyDefinition.parameters)
    expect(draft.definition.verification).toEqual(legacyDefinition.verification)
    expect((await (await request("/drafts/from-legacy", "POST", input)).json() as A.Draft).id).toBe(draft.id)
    expect((await request(`/drafts/${draft.id}/publish`, "POST", { version: 1, runId: sourceId })).status).toBe(409)
    const tested = await (await request(`/drafts/${draft.id}/runs`, "POST", { version: 1, requestKey: crypto.randomUUID(), parameters: { text: "中文参数" } })).json() as A.Run
    await processAutomationRun(tested.id)
    await request(`/runs/${tested.id}/resume`, "POST", { action: "confirm" })
    outputs.set(`/api/session/${sid}/fs/read/output/automation/${tested.id}/report.json`, "REPORT_OK")
    await processAutomationRun(tested.id)
    expect((await status(tested.id)).status).toBe("succeeded")
    const published = await request(`/drafts/${draft.id}/publish`, "POST", { version: 1, runId: tested.id })
    expect(published.status).toBe(201)
    const fixed = await published.json() as A.App
    appIds.push(fixed.id)
    expect(fixed.legacyAppId).toBe(legacyId)
    const [stored] = await db.select().from(automationApp).where(eq(automationApp.id, fixed.id))
    expect(stored?.legacyAppId).toBe(legacyId)
  }, 40_000)

  test("沉淀应用：无草稿时明确拒绝，不假装成功", async () => {
    const sid = await session()
    const res = await request(`/${sid}/distill`, "POST", {})
    expect(res.status).toBe(409)
    expect((await res.json() as { message?: string }).message).toContain("还没有可发布的草稿")
  }, 30_000)

  test("沉淀应用：平台自动测试并在门槛满足后发布；跳过步骤不发布", async () => {
    const sid = await session()
    const created = await request("/drafts", "POST", { sessionId: sid, definition: value })
    expect(created.status).toBe(201)
    const draft = await created.json() as A.Draft

    // 第一次调用：没有测试记录，平台自己发起草稿测试。
    const first = await request(`/${sid}/distill`, "POST", {})
    expect(first.status).toBe(202)
    const started = await first.json() as { status: string; runId: string }
    expect(started.status).toBe("testing")

    // 测试还没跑完时再次请求：返回同一运行，不重复创建。
    const again = await request(`/${sid}/distill`, "POST", {})
    expect((await again.json() as { runId: string }).runId).toBe(started.runId)

    // 推进测试（脚本需确认）→ 完整成功。
    await processAutomationRun(started.runId)
    await request(`/runs/${started.runId}/resume`, "POST", { action: "confirm" })
    await processAutomationRun(started.runId)
    expect((await status(started.runId)).status).toBe("succeeded")

    // 第二次调用：复用成功测试并发布。
    const published = await request(`/${sid}/distill`, "POST", {})
    expect(published.status).toBe(200)
    const result = await published.json() as { status: string; appId: string; reusedRun?: boolean }
    expect(result.status).toBe("published")
    expect(result.reusedRun).toBe(true)
    appIds.push(result.appId)
    const [app] = await db.select().from(automationApp).where(eq(automationApp.id, result.appId))
    expect(app?.version).toBe(1)

    // 再调用是幂等的，不会创建第二个应用。
    const idempotent = await request(`/${sid}/distill`, "POST", {})
    const againResult = await idempotent.json() as { status: string; appId: string }
    expect(againResult.status).toBe("already_published")
    expect(againResult.appId).toBe(result.appId)
  }, 60_000)

  test("沉淀应用：测试有跳过步骤时拒绝发布", async () => {
    const sid = await session()
    const created = await request("/drafts", "POST", { sessionId: sid, definition: value })
    const draft = await created.json() as A.Draft
    const started = await (await request(`/${sid}/distill`, "POST", {})).json() as { runId: string }
    // 先推进到脚本确认暂停，再由人工「跳过」，制造「跳过完成」的成功运行。
    await processAutomationRun(started.runId)
    const paused = await status(started.runId)
    expect(paused.status).toBe("paused")
    expect(paused.results[0]?.pauseReason).toBe("confirmation")
    await request(`/runs/${started.runId}/resume`, "POST", { action: "skip" })
    await processAutomationRun(started.runId)
    const final = await status(started.runId)
    expect(final.status).toBe("succeeded")
    expect(final.results[0]?.skipped).toBe(true)

    const res = await request(`/${sid}/distill`, "POST", {})
    // 跳过不算验证成功：不会发布（要么重新起测试，要么明确冲突）。
    const body = await res.json() as { status?: string; appId?: string }
    if (body.status === "published") throw new Error("跳过的步骤不应被发布")
    const [draftRow] = await db.select().from(automationDraft).where(eq(automationDraft.id, draft.id))
    expect(draftRow?.publishedAppId).toBeNull()
  }, 60_000)

  test("可观察流式草稿生成：发起临时会话、轮询完成后幂等落库", async () => {
    const sid = await session()
    const start = await request("/draft/start", "POST", { sessionId: sid })
    expect(start.status).toBe(200)
    const job = await start.json() as { sessionId: string; promptId: string; sourceSessionId: string }
    expect(job.sessionId).toMatch(/^ses_ai_/)
    expect(job.sourceSessionId).toBe(sid)
    // 临时生成会话必须授权给发起用户，否则其 SSE 订阅与结果轮询都会 404。
    const owner = await check(db, { subject: { type: "user", id: userIds[0]! }, permission: "read", object: { type: "session", id: job.sessionId } })
    expect(owner).toBe(true)
    expect((await request("/draft/result", "POST", { job: { sessionId: job.sessionId, promptId: job.promptId }, sourceSessionId: sid }, other)).status).toBe(404)
    const first = await (await request("/draft/result", "POST", { job: { sessionId: job.sessionId, promptId: job.promptId }, sourceSessionId: sid })).json() as { status: string; draft?: A.Draft }
    expect(first.status).toBe("ready")
    expect(first.draft?.definition.steps).toHaveLength(value.steps.length)
    const again = await (await request("/draft/result", "POST", { job: { sessionId: job.sessionId, promptId: job.promptId }, sourceSessionId: sid })).json() as { status: string; draft?: A.Draft }
    expect(again.draft?.id).toBe(first.draft?.id)
  }, 40_000)

  test("完成标准只接受本次独立目录的产物；缺失时暂停而非误报成功", async () => {
    const item = await create({ ...value, verification: { path: "report.json", contains: "REPORT_OK" } })
    const run = await (await start(item.id)).json() as A.Run
    await processAutomationRun(run.id)
    await request(`/runs/${run.id}/resume`, "POST", { action: "confirm" })
    await processAutomationRun(run.id)
    const failed = await status(run.id)
    expect(failed.status).toBe("paused")
    expect(failed.results[0]?.pauseReason).toBe("failed")
    expect(failed.error).toContain("未找到本次产物")
    expect((await request(`/runs/${run.id}/resume`, "POST", { action: "stop" })).status).toBe(200)
  })
  test("仅从授权会话固定路径导入有限大小的草稿 JSON", async () => {
    const sid = await session()
    draftFile = JSON.stringify(value)
    expect((await request("/drafts/import", "POST", { sessionId: sid }, other)).status).toBe(404)
    const response = await request("/drafts/import", "POST", { sessionId: sid })
    expect(response.status).toBe(201)
    const imported = await response.json() as { sessionId: string; definition: A.Definition }
    expect(imported.sessionId).toBe(sid)
    expect(imported.definition).toEqual(value)
    draftFile = JSON.stringify(value)
    const key = `fixed-${Date.now()}`
    const once = await (await request("/drafts/import", "POST", { sessionId: sid, generationKey: key })).json() as { id: string }
    draftFile = "{" // 再次导入应命中 PG 的幂等记录，而不是读取可能已变化的文件
    const again = await (await request("/drafts/import", "POST", { sessionId: sid, generationKey: key })).json() as { id: string }
    expect(again.id).toBe(once.id)
    const [stored] = await db.select().from(automationDraft).where(eq(automationDraft.id, once.id))
    expect(stored?.generationKey).toBe(key)
    draftFile = "{"
    expect((await request("/drafts/import", "POST", { sessionId: sid })).status).toBe(400)
    draftFile = "x".repeat(256 * 1024 + 1)
    expect((await request("/drafts/import", "POST", { sessionId: sid })).status).toBe(400)
  })
  test("草稿独立测试，当前版本成功后才能幂等发布", async () => {
    const sid = await session()
    const draft = await (await request("/drafts", "POST", { sessionId: sid, definition: value })).json() as { id: string; version: number }
    const key = crypto.randomUUID()
    const input = { version: 1, requestKey: key, parameters: { text: "中文参数" } }
    const first = await request(`/drafts/${draft.id}/runs`, "POST", input)
    expect(first.status).toBe(201)
    const run = await first.json() as A.Run
    expect(run.appId).toBeNull()
    const history = await (await request(`/drafts/${draft.id}/runs`)).json() as { items: A.Run[] }
    expect(history.items.map((item) => item.id)).toContain(run.id)
    expect((await request(`/drafts/${draft.id}/runs`, "GET", undefined, other)).status).toBe(404)
    let invalidSourceRejected = false
    try { await db.update(automationRun).set({ draftHash: null }).where(eq(automationRun.id, run.id)) } catch { invalidSourceRejected = true }
    expect(invalidSourceRejected).toBe(true)
    expect(((await (await request(`/drafts/${draft.id}/runs`, "POST", input)).json()) as A.Run).id).toBe(run.id)
    expect((await request(`/drafts/${draft.id}/publish`, "POST", { version: 1, runId: run.id })).status).toBe(409)
    await processAutomationRun(run.id)
    await request(`/runs/${run.id}/resume`, "POST", { action: "confirm" })
    await processAutomationRun(run.id)
    expect((await status(run.id)).status).toBe("succeeded")
    const published = await request(`/drafts/${draft.id}/publish`, "POST", { version: 1, runId: run.id })
    expect(published.status).toBe(201)
    const app = await published.json() as A.App
    appIds.push(app.id)
    expect(((await (await request(`/drafts/${draft.id}/publish`, "POST", { version: 1, runId: run.id })).json()) as A.App).id).toBe(app.id)
    expect((await request(`/drafts/${draft.id}`, "PUT", { version: 1, definition: value })).status).toBe(409)
  })
  test("跳过步骤、未合并修复和过期版本均不能发布", async () => {
    const sid = await session()
    const draft = await (await request("/drafts", "POST", { sessionId: sid, definition: value })).json() as { id: string }
    const run = await (await request(`/drafts/${draft.id}/runs`, "POST", { version: 1, requestKey: crypto.randomUUID(), parameters: { text: "测试" } })).json() as A.Run
    await db.update(automationRun).set({ status: "succeeded", cursor: 1, results: [{ stepId: "data", status: "succeeded", repairAttempts: 0, skipped: true }] }).where(eq(automationRun.id, run.id))
    expect((await request(`/drafts/${draft.id}/publish`, "POST", { version: 1, runId: run.id })).status).toBe(409)
    await db.update(automationRun).set({ results: [{ stepId: "data", status: "succeeded", repairAttempts: 1, repairedOperation: { type: "script", runtime: "python", source: "print('fixed')" } }] }).where(eq(automationRun.id, run.id))
    expect((await request(`/drafts/${draft.id}/publish`, "POST", { version: 1, runId: run.id })).status).toBe(409)
    expect((await request(`/drafts/${draft.id}/apply-repair`, "POST", { version: 1, runId: run.id }, other)).status).toBe(404)
    const repaired = await request(`/drafts/${draft.id}/apply-repair`, "POST", { version: 1, runId: run.id })
    expect(repaired.status).toBe(200)
    const changed = await repaired.json() as { version: number; definition: A.Definition }
    expect(changed.version).toBe(2)
    expect(changed.definition.steps[0]?.operation).toMatchObject({ source: "print('fixed')" })
    expect((await request(`/drafts/${draft.id}/publish`, "POST", { version: 2, runId: run.id })).status).toBe(409)
  })
  test("会话草稿按用户隔离、版本化并拒绝并发覆盖", async () => {
    const sid = await session()
    expect((await request("/drafts", "POST", { sessionId: sid, definition: value }, other)).status).toBe(404)
    expect((await request("/drafts", "POST", { sessionId: sid, definition: { ...value, steps: [] } })).status).toBe(400)
    const created = await request("/drafts", "POST", { sessionId: sid, definition: value })
    expect(created.status).toBe(201)
    const draft = await created.json() as { id: string; version: number; contentHash: string }
    expect(draft.version).toBe(1)
    expect(draft.contentHash).toMatch(/^[a-f0-9]{64}$/)
    expect((await request(`/drafts/${draft.id}`, "GET", undefined, other)).status).toBe(404)
    const listing = await (await request(`/drafts?sessionId=${encodeURIComponent(sid)}`)).json() as { items: Array<{ id: string }> }
    expect(listing.items.map((item) => item.id)).toContain(draft.id)
    expect((await request(`/drafts?sessionId=${encodeURIComponent(sid)}`, "GET", undefined, other)).status).toBe(404)
    const updates = await Promise.all([
      request(`/drafts/${draft.id}`, "PUT", { version: 1, definition: { ...value, name: "报告 A" } }),
      request(`/drafts/${draft.id}`, "PUT", { version: 1, definition: { ...value, name: "报告 B" } }),
    ])
    expect(updates.map((res) => res.status).sort()).toEqual([200, 409])
    const saved = await (await request(`/drafts/${draft.id}`)).json() as { version: number; contentHash: string }
    expect(saved.version).toBe(2)
    expect(saved.contentHash).not.toBe(draft.contentHash)
    const [stored] = await db.select().from(automationDraft).where(eq(automationDraft.id, draft.id))
    expect(stored?.contentHash).toBe(saved.contentHash)
  })
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
  test("已发布脚本在启动时确认后直接执行，不逐步暂停或调用模型", async () => {
    const item = await create({ ...value, steps: [
      { id: "one", title: "准备数据", operation: { type: "script", runtime: "python", source: "print('one')" } },
      { id: "two", title: "生成结果", operation: { type: "script", runtime: "python", source: "print('two')" } },
    ] })
    const sid = await session()
    const response = await request(`/${item.id}/runs`, "POST", { sessionId: sid, requestKey: crypto.randomUUID(), parameters: { text: "中文参数" }, confirmed: true })
    expect(response.status).toBe(201)
    const run = await response.json() as A.Run
    const before = scriptCalls, beforePrompts = promptCalls
    for (let index = 0; index < 3; index++) await processAutomationRun(run.id)
    const done = await status(run.id)
    expect(done.status).toBe("succeeded")
    expect(done.results.map((step) => step.status)).toEqual(["succeeded", "succeeded"])
    expect(scriptCalls - before).toBe(2)
    expect(promptCalls).toBe(beforePrompts)
    const [stored] = await db.select().from(automationRun).where(eq(automationRun.id, run.id))
    expect(stored?.cursor).toBe(2)
  })
  test("一次确认只预授权固定脚本，不预授权网页点击", async () => {
    const item = await create({ ...value, steps: [
      { id: "click", title: "提交", operation: { type: "browser", action: "click", selector: "#submit" } },
      { id: "script", title: "处理文件", operation: { type: "script", runtime: "python", source: "print('ok')" } },
    ] })
    const run = await (await request(`/${item.id}/runs`, "POST", { sessionId: await session(), requestKey: crypto.randomUUID(), parameters: { text: "测试" }, confirmed: true })).json() as A.Run
    expect(run.results.map((step) => step.approved)).toEqual([false, true])
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
  test("已发布应用：修复重跑成功自动保存新版本；跳过步骤不保存", async () => {
    const item = await create()
    const repaired = { type: "script", runtime: "python", source: "print('fixed')" } as const
    // 修复方案待审核 → 用户确认 → worker 重跑成功 → 自动固化为 v2。
    const run = (await (await start(item.id)).json()) as A.Run
    await db
      .update(automationRun)
      .set({
        status: "paused",
        cursor: 0,
        results: [{ stepId: "data", status: "paused", repairAttempts: 1, repairedOperation: repaired, pauseReason: "repair_review" }],
      })
      .where(eq(automationRun.id, run.id))
    await request(`/runs/${run.id}/resume`, "POST", { action: "confirm" })
    await processAutomationRun(run.id)
    const done = await status(run.id)
    expect(done.status).toBe("succeeded")
    expect(done.repairApplied).toBe(true)
    const [saved] = await db.select().from(automationApp).where(eq(automationApp.id, item.id))
    expect(saved?.version).toBe(2)
    expect(saved?.definition.steps[0]?.operation).toEqual(repaired)
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.resourceId, item.id), eq(auditLog.action, "automation.apply_repair")))
    expect(audit).toBeDefined()

    // 对照：跳过完成的修复不保存，应用停留原版本。
    // 先让 worker 跑到脚本确认暂停，再执行 skip——直接对未开始的运行 skip 不会推进状态。
    const skipRun = (await (await start(item.id)).json()) as A.Run
    await processAutomationRun(skipRun.id)
    expect((await status(skipRun.id)).results[0]?.pauseReason).toBe("confirmation")
    await request(`/runs/${skipRun.id}/resume`, "POST", { action: "skip" })
    await processAutomationRun(skipRun.id)
    const skipped = await status(skipRun.id)
    expect(skipped.status).toBe("succeeded")
    expect(skipped.repairApplied).toBe(false)
    const [unchanged] = await db.select().from(automationApp).where(eq(automationApp.id, item.id))
    expect(unchanged?.version).toBe(2)
  }, 40_000)
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
    // 定位修复经重跑验证成功后，worker 已自动固化为新版本，无需再手动 apply-repair。
    expect((await status(run.id)).repairApplied).toBe(true)
    expect(((await (await request(`/${item.id}`)).json()) as { app: A.App }).app.version).toBe(2)
    // 已保存过，手动入口应拒绝重复应用。
    expect((await request(`/runs/${run.id}/apply-repair`, "POST")).status).toBe(409)
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
    expect((await request(`/runs/${run.id}/apply-repair`, "POST")).status).toBe(409)
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
