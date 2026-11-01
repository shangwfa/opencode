/** 多实例验收：两个基础服务实例共享同一 PG 与 SaaS，验证副作用只执行一次，崩溃后不重放。 */
import { eq } from "drizzle-orm"
import type { AutomationApp as A } from "@opencode/schema/automation-app"
import { db, pool } from "../src/db"
import { automationRun } from "../src/db/schema"

const pod = { a: process.env.POD_A ?? "http://localhost:15313", b: process.env.POD_B ?? "http://localhost:15314" }
const saas = process.env.OPENCODE_SAAS_URL ?? "http://localhost:15296"
const password = process.env.OPENCODE_PASSWORD ?? ""
const assert = (ok: unknown, message: string) => {
  if (!ok) throw new Error(message)
}

async function signup(base: string) {
  const email = `multipod-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`
  const res = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3001" },
    body: JSON.stringify({ email, password: "ab123456", name: "多实例验收" }),
  })
  assert(res.ok, `注册失败 ${res.status}`)
  return res.headers.get("set-auth-token") ?? ""
}

async function api<T>(base: string, token: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) throw new Error(`${base}${path}: ${res.status} ${(await res.text()).slice(0, 300)}`)
  return (await res.json()) as T
}

/** 统计 SaaS 沙箱中真正派发的数据处理脚本次数（python3 -c 为固定执行器入口）。 */
async function scriptExecutions(sessionId: string) {
  const res = await fetch(`${saas}/api/experimental/session/${sessionId}/log?follow=false&after=0`, {
    headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
  })
  const text = await res.text()
  const events: Array<{ type?: string; data?: { shell?: { command?: string } } }> = text.trim().startsWith("[")
    ? JSON.parse(text)
    : text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => JSON.parse(line.slice(5).trim()))
  return events.filter((event) => event.type === "session.shell.started" && event.data?.shell?.command?.startsWith("python3 -c")).length
}

const definition: A.Definition = {
  name: "多实例脚本验收",
  description: "两个实例同时推进同一运行",
  parameters: [],
  steps: [
    {
      id: "work",
      title: "执行一次固定数据处理",
      operation: { type: "script", runtime: "python", source: "import time,json\ntime.sleep(3)\nprint(json.dumps({'ok': 1}))" },
    },
  ],
}

const evidence: Record<string, unknown> = {}
try {
  const token = await signup(pod.a)
  const session = await api<{ session: { id: string } }>(pod.a, token, "/sessions", { title: "多实例验收" })
  const sid = session.session.id
  const app = await api<A.App>(pod.a, token, "/automation-apps", definition)
  // 同一运行只能由一个实例拿到锁：两边都请求推进，但副作用应只发生一次。
  let run = await api<A.Run>(pod.a, token, `/automation-apps/${app.id}/runs`, {
    sessionId: sid,
    requestKey: crypto.randomUUID(),
    parameters: {},
  })
  let confirmed = false
  const deadline = Date.now() + 240_000
  while (Date.now() < deadline) {
    const [fromA, fromB] = await Promise.all([
      api<A.Run>(pod.a, token, `/automation-apps/runs/${run.id}`),
      api<A.Run>(pod.b, token, `/automation-apps/runs/${run.id}`),
    ])
    run = fromA
    // 两次读取之间状态可能合法地推进，因此只要求两个实例都能读到同一运行。
    assert(fromB.id === fromA.id, "另一实例读到了不同的运行")
    if (run.status === "succeeded" || run.status === "failed") break
    if (run.status === "paused" && run.results[0]?.pauseReason === "confirmation" && !confirmed) {
      confirmed = true
      // 确认请求经另一实例提交，模拟负载均衡后的真实路由。
      await api(pod.b, token, `/automation-apps/runs/${run.id}/resume`, { action: "confirm" })
    }
    await Bun.sleep(1000)
  }
  assert(run.status === "succeeded", `运行未成功：${run.status} ${run.error ?? ""}`)
  const executions = await scriptExecutions(sid)
  evidence.normal = { runId: run.id, executions }
  assert(executions === 1, `同一运行被执行了 ${executions} 次，应为 1`)
  console.log("通过：双实例并发推进，脚本仅执行 1 次")

  // 崩溃恢复：派发后进程消失（状态停留 running），恢复后必须暂停等待核实，且不重放。
  const crash = await api<A.Run>(pod.a, token, `/automation-apps/${app.id}/runs`, {
    sessionId: sid,
    requestKey: crypto.randomUUID(),
    parameters: {},
  })
  const confirmedBefore = Date.now() + 240_000
  while (Date.now() < confirmedBefore) {
    const current = await api<A.Run>(pod.a, token, `/automation-apps/runs/${crash.id}`)
    if (current.status === "paused" && current.results[0]?.pauseReason === "confirmation") break
    await Bun.sleep(1000)
  }
  const before = await scriptExecutions(sid)
  await db
    .update(automationRun)
    .set({ status: "running", results: [{ stepId: "work", status: "running", repairAttempts: 0, approved: true }] })
    .where(eq(automationRun.id, crash.id))
  await Bun.sleep(8000)
  const after = await api<A.Run>(pod.b, token, `/automation-apps/runs/${crash.id}`)
  assert(after.status === "paused" && after.results[0]?.pauseReason === "uncertain", `崩溃后应暂停为不确定，实际 ${after.status}`)
  const replay = await scriptExecutions(sid)
  evidence.crash = { runId: crash.id, before, replay, pauseReason: after.results[0]?.pauseReason }
  assert(replay === before, `崩溃后脚本被重放：${before} → ${replay}`)
  console.log("通过：执行中崩溃后暂停等待核实，未重放")
  evidence.passed = true
} catch (error) {
  evidence.passed = false
  evidence.error = error instanceof Error ? error.message : String(error)
  console.error("失败：", evidence.error)
  process.exitCode = 1
} finally {
  console.log(JSON.stringify(evidence, null, 2))
  await pool.end()
}
