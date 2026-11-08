import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { eq, inArray } from "drizzle-orm"
import type { AutomationInstruction as I } from "@opencode/schema/automation-instruction"
import { createApp } from "../src/app"
import { db, pool } from "../src/db"
import { ensureSchema } from "../src/db/ensure-schema"
import {
  instructionApp,
  instructionDraft,
  instructionRun,
  auditLog,
  relationTuple,
  user,
} from "../src/db/schema"
import { env } from "../src/config/env"
import { writeTuples } from "../src/authz"
import { processInstructionRun } from "../src/automation/instruction/worker"

const app = createApp()
const prefix = `inst_${crypto.randomUUID()}`
const userIds: string[] = []
const sessionIds: string[] = []
let owner = ""
let other = ""
let upstream: ReturnType<typeof Bun.serve>
const previousUrl = process.env.OPENCODE_SAAS_URL
const prompts = new Map<string, Array<{ id: string; text: string; permissions?: unknown }>>()
let failExecution = false
let failPollOnce = false
let failDispatch = false

const definition: I.Definition = {
  name: "整理订单",
  description: "只读汇总",
  parameters: [],
  instructions: [{ id: "read", title: "读取订单", text: "读取订单并输出汇总" }],
}

function request(path: string, method = "GET", body?: unknown, token = owner) {
  return app.request(`/api/instruction-apps${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function login(name: string) {
  const response = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: env.webOrigin },
    body: JSON.stringify({ name, email: `${prefix}_${name}@example.com`, password: "ab123456" }),
  })
  expect(response.status).toBe(200)
  userIds.push(((await response.json()) as { user: { id: string } }).user.id)
  return response.headers.get("set-auth-token")!
}

async function session() {
  const id = `ses_${crypto.randomUUID().replaceAll("-", "")}`
  sessionIds.push(id)
  await writeTuples(db, [
    { resourceType: "session", resourceId: id, relation: "owner", subjectType: "user", subjectId: userIds[0]! },
  ])
  return id
}

async function runRow(id: string) {
  const [row] = await db.select().from(instructionRun).where(eq(instructionRun.id, id))
  return row!
}

async function settle(id: string) {
  for (let attempt = 0; attempt < 20; attempt++) {
    await processInstructionRun(id)
    const row = await runRow(id)
    if (["succeeded", "failed", "paused"].includes(row.status)) return row
  }
  throw new Error(`运行未在预期内结束：${id}`)
}

const executionCount = (sessionId: string) =>
  (prompts.get(sessionId) ?? []).filter((item) => item.text.includes("个业务步骤，本次只完成这一步")).length

beforeAll(async () => {
  if (env.databaseSchema === "hn_base") throw new Error("必须使用独立 BASE_DATABASE_SCHEMA")
  await ensureSchema(pool)
  upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const id = url.pathname.split("/")[3] ?? ""
      if (url.pathname.endsWith("/permission") && req.method === "GET")
        return Response.json({ data: [{ id: "per_test", sessionID: id, action: "read", resources: ["output/report.json"] }] })
      if (url.pathname.endsWith("/permission/per_test/reply") && req.method === "POST")
        return (await req.json() as { decision: string }).decision === "once" ? new Response(null, { status: 204 }) : new Response("invalid", { status: 400 })
      if (url.pathname === "/api/session" && req.method === "POST")
        return Response.json({ data: { id: `ses_ai_${crypto.randomUUID().replaceAll("-", "")}` } })
      if (url.pathname.endsWith("/prompt")) {
        const body = (await req.json()) as { id: string; text: string; permissions?: unknown }
        prompts.set(id, [...(prompts.get(id) ?? []), body])
        if (failDispatch && body.text.includes("个业务步骤，本次只完成这一步")) return new Response("unavailable", { status: 503 })
        return Response.json({})
      }
      if (url.pathname.includes("/fs/read/")) {
        if (url.pathname.endsWith("/output/report.json")) return new Response("REPORT_OK")
        return new Response("not found", { status: 404 })
      }
      if (url.pathname.endsWith("/message")) {
        if (failPollOnce) {
          failPollOnce = false
          return new Response("upstream unavailable", { status: 500 })
        }
        const prompt = prompts.get(id)?.at(-1)
        if (!prompt) return Response.json({ data: [] })
        if (prompt.text.includes("个业务步骤，本次只完成这一步"))
          return Response.json({
            data: [
              {
                type: "assistant",
                promptMessageID: prompt.id,
                ...(failExecution
                  ? { content: [], error: { message: "找不到订单表" } }
                  : { content: [{ type: "text", text: "订单报告完成" }], time: { created: 1, completed: 2 } }),
              },
              // 同一会话的其他轮次：不属于本次运行，不应出现在执行过程里
              { type: "assistant", promptMessageID: "msg_other", content: [{ type: "text", text: "别的轮次" }], time: { created: 1, completed: 2 } },
            ],
          })
        if (prompt.text.includes("在一次真实执行中失败"))
          return Response.json({
            data: [{
              type: "assistant",
              promptMessageID: prompt.id,
              structured: { status: "ready", reason: "", ...definition, description: "重新生成后的只读汇总" },
            }],
          })
        if (prompt.text.includes("整理成可重复执行的业务步骤应用"))
          return Response.json({
            data: [{ type: "assistant", promptMessageID: prompt.id, structured: { status: "ready", reason: "", ...definition, verification: { path: "output/report.json", contains: "REPORT_OK" } } }],
          })
        return Response.json({ data: [] })
      }
      if (url.pathname.endsWith("/abort") || req.method === "DELETE") return Response.json({})
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
  if (userIds.length) {
    await db.delete(instructionRun).where(inArray(instructionRun.ownerId, userIds))
    await db.delete(instructionDraft).where(inArray(instructionDraft.ownerId, userIds))
    await db.delete(instructionApp).where(inArray(instructionApp.ownerId, userIds))
    await db.delete(auditLog).where(inArray(auditLog.actorId, userIds))
  }
  if (sessionIds.length) await db.delete(relationTuple).where(inArray(relationTuple.resourceId, sessionIds))
  if (userIds.length) await db.delete(user).where(inArray(user.id, userIds))
})

async function insertApp(value: I.Definition, requiresConfirm = false) {
  const definition = requiresConfirm
    ? { ...value, instructions: value.instructions.map((item) => ({ ...item, requiresConfirmation: true })) }
    : value
  const [row] = await db.insert(instructionApp).values({
    id: `inst_${crypto.randomUUID()}`, ownerId: userIds[0]!, definition, version: 1,
    timeCreated: Date.now(), timeUpdated: Date.now(),
  }).returning()
  return row!
}

describe("指令应用 HTTP + 真实 PG + 模拟 SaaS", () => {
  test("待确认工具权限按会话归属代理，且只允许本次批准或拒绝", async () => {
    const sid = await session()
    const path = `/api/sessions/${sid}/permissions`
    const headers = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" })
    expect((await app.request(path, { headers: headers(other) })).status).toBe(404)
    const list = await app.request(path, { headers: headers(owner) })
    expect(list.status).toBe(200)
    expect((await list.json() as { data: Array<{ action: string }> }).data[0]?.action).toBe("read")
    const reply = `${path}/per_test/reply`
    expect((await app.request(reply, { method: "POST", headers: headers(other), body: JSON.stringify({ decision: "once" }) })).status).toBe(404)
    expect((await app.request(reply, { method: "POST", headers: headers(owner), body: JSON.stringify({ decision: "always" }) })).status).toBe(400)
    expect((await app.request(reply, { method: "POST", headers: headers(owner), body: JSON.stringify({ decision: "once" }) })).status).toBe(200)
  })
  test("同一生成请求并发及重试只保存一个草稿", async () => {
    const sid = await session()
    const input = { sessionId: sid, generationKey: "marker-123" }
    const responses = await Promise.all([request("/drafts/generate", "POST", input), request("/drafts/generate", "POST", input)])
    const bodies = await Promise.all(responses.map((response) => response.json() as Promise<{ draft: I.Draft }>))
    expect(bodies[0]!.draft.id).toBe(bodies[1]!.draft.id)
    const retry = await request("/drafts/generate", "POST", input)
    expect(retry.status).toBe(200)
    expect(((await retry.json()) as { draft: I.Draft }).draft.id).toBe(bodies[0]!.draft.id)
    expect((await request("/drafts/generate", "POST", input, other)).status).toBe(404)
  })
  test("会话权限撤销后不可读取运行详情和历史", async () => {
    const sid = await session()
    const created = await insertApp(definition)
    const run = await (await request(`/apps/${created.id}/runs`, "POST", { sessionId: sid, requestKey: crypto.randomUUID(), parameters: {} })).json() as I.Run
    await db.delete(relationTuple).where(eq(relationTuple.resourceId, sid))
    expect((await request(`/runs/${run.id}`)).status).toBe(404)
    const history = await (await request(`/apps/${created.id}/runs`)).json() as { items: I.Run[] }
    expect(history.items).toEqual([])
  })
  test("并发派发及上游响应不确定时不重复发送", async () => {
    const sid = await session()
    const created = await insertApp(definition)
    const response = await request(`/apps/${created.id}/runs`, "POST", { sessionId: sid, requestKey: crypto.randomUUID(), parameters: {} })
    const run = await response.json() as I.Run
    failDispatch = true
    try {
      await Promise.all([processInstructionRun(run.id), processInstructionRun(run.id)])
      const paused = await runRow(run.id)
      expect(paused.status).toBe("paused")
      expect(paused.promptId).toBeTruthy()
      expect(executionCount(sid)).toBe(1)
      expect((await request(`/runs/${run.id}/resume`, "POST", { action: "retry" })).status).toBe(200)
      await processInstructionRun(run.id)
      expect(executionCount(sid)).toBe(1)
    } finally { failDispatch = false }
  })
  test("生成草稿受会话权限约束，生成过程不开放工具", async () => {
    const sid = await session()
    expect((await request("/drafts/generate", "POST", { sessionId: sid }, other)).status).toBe(404)
    const response = await request("/drafts/generate", "POST", { sessionId: sid })
    expect(response.status).toBe(201)
    const body = (await response.json()) as { definition: I.Definition; draft: I.Draft }
    expect(body.definition.instructions).toEqual(definition.instructions)
    expect(body.definition.verification).toEqual({ path: "output/report.json", contains: "REPORT_OK" })
    expect(Object.hasOwn(body.definition, "steps")).toBe(false)
    const generated = [...prompts.values()].flat().find((item) =>
      item.text.includes("整理成可重复执行的业务步骤应用"),
    )
    expect(generated?.permissions).toEqual([{ action: "*", resource: "*", effect: "deny" }])
    expect((await request(`/drafts?sessionId=${sid}`, "GET", undefined, other)).status).toBe(404)
    expect(((await (await request(`/drafts?sessionId=${sid}`)).json()) as { items: unknown[] }).items).toHaveLength(1)

    const updated = await request(`/drafts/${body.draft.id}`, "PUT", {
      version: 1,
      definition: { ...body.definition, description: "更新后的汇总" },
    })
    expect(updated.status).toBe(200)
    expect(((await updated.json()) as I.Draft).version).toBe(2)
    expect((await request(`/drafts/${body.draft.id}`, "PUT", { version: 1, definition: body.definition })).status).toBe(409)
  })

  test("完整执行成功后才能发布，应用执行不会重复派发", async () => {
    const sid = await session()
    const generated = (await (await request("/drafts/generate", "POST", { sessionId: sid })).json()) as {
      definition: I.Definition
      draft: I.Draft
    }
    const draft = generated.draft
    const key = crypto.randomUUID()
    const input = { version: 1, requestKey: key, parameters: {} }

    expect((await request(`/drafts/${draft.id}/publish`, "POST", { version: 1, runId: "irun_missing" })).status).toBe(409)
    expect((await request(`/drafts/${draft.id}/runs`, "POST", { ...input, version: 2 })).status).toBe(409)

    const queued = (await (await request(`/drafts/${draft.id}/runs`, "POST", input)).json()) as I.Run
    expect((await (await request(`/drafts/${draft.id}/runs`, "POST", input)).json()) as I.Run).toMatchObject({ id: queued.id })
    const succeeded = await settle(queued.id)
    expect(succeeded.status).toBe("succeeded")
    expect(succeeded.output).toBe("【读取订单】\n订单报告完成")
    // 逐步执行：每个步骤一条记录，完成后才推进
    expect(succeeded.steps.map((step) => ({ title: step.title, status: step.status }))).toEqual([
      { title: "读取订单", status: "succeeded" },
    ])
    expect(executionCount(sid)).toBe(1)
    expect(prompts.get(sid)?.at(-1)?.permissions).toEqual([{ action: "*", resource: "*", effect: "allow" }])
    // 执行过程只返回本次运行的消息，不含同一会话的其他轮次
    const process = await request(`/runs/${queued.id}/messages`)
    expect(process.status).toBe(200)
    const processMessages = (await process.json()) as { data: Array<{ promptMessageID?: string }> }
    expect(processMessages.data).toHaveLength(1)
    expect(processMessages.data[0]?.promptMessageID).toBe(succeeded.promptId ?? "")
    expect((await request(`/runs/${queued.id}/messages`, "GET", undefined, other)).status).toBe(404)
    expect((await request(`/drafts/${draft.id}/publish`, "POST", { version: 1, runId: queued.id }, other)).status).toBe(404)

    const published = await request(`/drafts/${draft.id}/publish`, "POST", { version: 1, runId: queued.id })
    expect(published.status).toBe(201)
    const created = (await published.json()) as I.App
    expect((((await (await request(`/drafts/${draft.id}`)).json()) as I.Draft).publishedAppId)).toBe(created.id)
    expect((await request(`/drafts/${draft.id}`, "PUT", { version: 1, definition: generated.definition })).status).toBe(409)

    const appRun = (await (await request(`/apps/${created.id}/runs`, "POST", { sessionId: sid, requestKey: crypto.randomUUID(), parameters: {} })).json()) as I.Run
    expect(appRun.appId).toBe(created.id)
    expect((await settle(appRun.id)).status).toBe("succeeded")
    expect(executionCount(sid)).toBe(2)
    const appRuns = await (await request(`/apps/${created.id}/runs`)).json() as { items: I.Run[] }
    expect(appRuns.items.map((item) => item.id)).toContain(appRun.id)
    expect((await request(`/apps/${created.id}/runs`, "GET", undefined, other)).status).toBe(404)
  })

  test("观察失败只暂停，恢复不会重发指令", async () => {
    const sid = await session()
    const appRow = await db.insert(instructionApp).values({
      id: `inst_${crypto.randomUUID()}`, ownerId: userIds[0]!, definition, version: 1,
      timeCreated: Date.now(), timeUpdated: Date.now(),
    }).returning()
    const created = appRow[0]!
    const run = (await (await request(`/apps/${created.id}/runs`, "POST", { sessionId: sid, requestKey: crypto.randomUUID(), parameters: {} })).json()) as I.Run

    await processInstructionRun(run.id)
    expect((await runRow(run.id)).status).toBe("running")
    expect(executionCount(sid)).toBe(1)
    failPollOnce = true
    await processInstructionRun(run.id)
    const paused = await runRow(run.id)
    expect(paused.status).toBe("paused")
    expect(paused.error).toContain("不会重发指令")
    expect(paused.promptId).toBeTruthy()

    const resumed = await request(`/runs/${run.id}/resume`, "POST", { action: "retry" })
    expect(resumed.status).toBe(200)
    expect((await settle(run.id)).status).toBe("succeeded")
    expect(executionCount(sid)).toBe(1)
  })

  test("高风险指令必须显式确认；结果校验失败不能算成功", async () => {
    const sid = await session()
    const guarded = await insertApp(definition, true)
    const unconfirmed = await request(`/apps/${guarded.id}/runs`, "POST", {
      sessionId: sid, requestKey: crypto.randomUUID(), parameters: {},
    })
    expect(unconfirmed.status).toBe(400)
    const confirmed = await request(`/apps/${guarded.id}/runs`, "POST", {
      sessionId: sid, requestKey: crypto.randomUUID(), parameters: {}, confirmed: true,
    })
    expect(confirmed.status).toBe(201)
    expect((await settle(((await confirmed.json()) as I.Run).id)).status).toBe("succeeded")

    const verified = await insertApp({ ...definition, verification: { path: "output/report.json", contains: "REPORT_OK" } })
    const verifiedRun = (await (await request(`/apps/${verified.id}/runs`, "POST", { sessionId: sid, requestKey: crypto.randomUUID(), parameters: {} })).json()) as I.Run
    expect((await settle(verifiedRun.id)).status).toBe("succeeded")

    const missing = await insertApp({ ...definition, verification: { path: "output/missing.json" } })
    const missingRun = (await (await request(`/apps/${missing.id}/runs`, "POST", { sessionId: sid, requestKey: crypto.randomUUID(), parameters: {} })).json()) as I.Run
    const failed = await settle(missingRun.id)
    expect(failed.status).toBe("failed")
    expect(failed.error).toContain("结果校验未通过")
    expect(failed.regeneratedVersion).toBeNull()
  })

  test("草稿含凭据时拒绝发布", async () => {
    const sid = await session()
    const [draft] = await db.insert(instructionDraft).values({
      id: `idraft_${crypto.randomUUID()}`, ownerId: userIds[0]!, sessionId: sid,
      definition: { ...definition, instructions: [{ ...definition.instructions[0]!, text: "token=abcdef123456" }] },
      version: 1, contentHash: "hash", timeCreated: Date.now(), timeUpdated: Date.now(),
    }).returning()
    const response = await request(`/drafts/${draft!.id}/publish`, "POST", { version: 1, runId: "irun_missing" })
    expect(response.status).toBe(400)
    expect(await response.text()).toContain("疑似包含凭据")
  })

  test("执行报错自动重生成应用，但不自动重跑", async () => {
    const sid = await session()
    const appRow = await db.insert(instructionApp).values({
      id: `inst_${crypto.randomUUID()}`, ownerId: userIds[0]!, definition, version: 1,
      timeCreated: Date.now(), timeUpdated: Date.now(),
    }).returning()
    const created = appRow[0]!
    const run = (await (await request(`/apps/${created.id}/runs`, "POST", { sessionId: sid, requestKey: crypto.randomUUID(), parameters: {} })).json()) as I.Run
    failExecution = true
    const failed = await settle(run.id)
    failExecution = false

    expect(failed.status).toBe("failed")
    expect(failed.regeneratedVersion).toBe(1)
    expect(failed.error).toContain("待审核草稿")
    expect(executionCount(sid)).toBe(1)
    const [updated] = await db.select().from(instructionApp).where(eq(instructionApp.id, created.id))
    expect(updated?.version).toBe(1)
    expect(updated?.definition.description).toBe(definition.description)
    const repaired = await db.select().from(instructionDraft).where(eq(instructionDraft.sessionId, sid))
    expect(repaired.some((item) => item.definition.description === "重新生成后的只读汇总")).toBe(true)

    const retry = (await (await request(`/apps/${created.id}/runs`, "POST", { sessionId: sid, requestKey: crypto.randomUUID(), parameters: {} })).json()) as I.Run
    expect(retry.appVersion).toBe(1)
    expect((await settle(retry.id)).status).toBe("succeeded")
    expect(executionCount(sid)).toBe(2)
  })
})
