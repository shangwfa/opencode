import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { createApp } from "../src/app"
import { ensureSchema } from "../src/db/ensure-schema"
import { db, pool } from "../src/db"
import { browserSession, browserScript, browserScriptVersion, relationTuple, auditLog, user } from "../src/db/schema"
import { and, eq, inArray } from "drizzle-orm"
import { allowedCdpMethod, validTarget } from "../src/lib/browser-cdp"
import { CDP_GATEWAY_BASE64 } from "../src/lib/cdp-gateway-source"
import {
  BROWSER_PROBE,
  chunkBase64,
  isTransientSandboxFailure,
  lockBrowserCommand,
  parseBrowserProbe,
  planBrowserLaunch,
} from "../src/lib/browser-cdp"
import { writeTuples } from "../src/authz"
import { env } from "../src/config/env"

const app = createApp()
const prefix = `browser_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`
const sessions: string[] = []
const scripts: string[] = []
const users: string[] = []
const shellCommands = new Map<string, string>()
const keepAliveCalls: string[] = []
const overlays = new Map<string, string>()
const sessionRequests = new Map<string, unknown>()
const missingSessions = new Set<string>()
let owner = "",
  other = "",
  upstreamCalls = 0,
  failStart = false
let navigated = "",
  frameAcknowledged = false
let repliedAnswer: unknown
let upstream: ReturnType<typeof Bun.serve>
const previousUrl = process.env.OPENCODE_SAAS_URL

async function login(name: string) {
  const response = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: env.webOrigin },
    body: JSON.stringify({ name, email: `${prefix}_${name}@example.com`, password: "ab123456" }),
  })
  expect(response.status).toBe(200)
  const body = (await response.json()) as { user: { id: string } }
  users.push(body.user.id)
  return response.headers.get("set-auth-token")!
}

/** 创建接口只返回 preparing；测试轮询到终态。 */
async function waitBrowser(id: string, token = owner) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const state = (await (await request(`/sessions/${id}/browser`, "GET", undefined, token)).json()) as {
      status: string
      error: string | null
    }
    if (state.status !== "preparing") return state
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("browser preparation timed out")
}

function request(path: string, method = "GET", body?: unknown, token = owner) {
  return app.request(`/api/browser${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

beforeAll(async () => {
  if (env.databaseSchema === "hn_base") throw new Error("必须使用独立的 BASE_DATABASE_SCHEMA")
  await ensureSchema(pool)
  upstream = Bun.serve({
    port: 0,
    websocket: {
      message(ws, raw) {
        const msg = JSON.parse(String(raw))
        if (msg.method === "Page.navigate") navigated = msg.params.url
        if (msg.method === "Page.screencastFrameAck") frameAcknowledged = true
        if (msg.method === "Page.startScreencast")
          ws.send(
            JSON.stringify({
              method: "Page.screencastFrame",
              params: { data: "FRAME", sessionId: 1, metadata: { deviceWidth: 100, deviceHeight: 100 } },
            }),
          )
        ws.send(JSON.stringify({ id: msg.id, result: {} }))
      },
    },
    fetch: async (req, server) => {
      upstreamCalls++
      const url = new URL(req.url)
      if (url.pathname.includes("/devtools/page/")) {
        server.upgrade(req, { data: undefined })
        return
      }
      if (url.pathname === "/api/session" && req.method === "POST") {
        const id = `ses_${crypto.randomUUID().replaceAll("-", "")}`
        sessionRequests.set(id, await req.json())
        sessions.push(id)
        return Response.json({ data: { id } })
      }
      if (url.pathname.includes("/keep-alive")) {
        keepAliveCalls.push(url.pathname.split("/")[4]!)
        return Response.json({ sessionID: url.pathname.split("/")[4]!, keepAlive: true })
      }
      const id = url.pathname.split("/")[3]!
      if (missingSessions.has(id)) return new Response(null, { status: 404 })
      if (url.pathname.endsWith("/agents-md")) {
        if (req.method === "POST") {
          const body = (await req.json()) as { content: string }
          overlays.set(id, body.content)
        }
        return Response.json({ data: overlays.has(id) ? { content: overlays.get(id) } : null })
      }
      if (url.pathname.endsWith("/shell")) {
        const body = (await req.json()) as { command: string }
        shellCommands.set(id, body.command)
        return Response.json({})
      }
      if (url.pathname.endsWith("/log")) {
        const sid = url.pathname.split("/")[4]!
        const command = shellCommands.get(sid) ?? ""
        // 探测命令必须回报仓库镜像的运行时，启动命令才走真实分支。
        const probe = command.includes("PROBE_DONE")
        return Response.json([
          {
            type: "session.shell.ended",
            data: {
              shell: { command, exit: !probe && failStart ? 1 : 0 },
              output: {
                output: probe ? "SCRIPT=/opt/cdp-browser/cdp-browser.sh\nFLOCK=1" : failStart ? "启动失败" : "ready",
              },
            },
          },
        ])
      }
      if (url.pathname.endsWith("/json/version")) return Response.json({ Browser: "Chromium" })
      if (url.pathname.endsWith("/form"))
        return Response.json({
          data: [{ id: "frm_test", sessionID: id, title: "确认操作", fields: [{ key: "approve", type: "boolean" }] }],
        })
      if (url.pathname.endsWith("/reply")) {
        const body = (await req.json()) as { answer: { approve?: boolean } }
        repliedAnswer = body.answer
        return body.answer.approve
          ? Response.json({ replied: true })
          : Response.json({ message: "invalid answer" }, { status: 400 })
      }
      if (url.pathname.endsWith("/json/list"))
        return Response.json([
          { id: "PAGE_A", type: "page", title: "示例", url: "https://example.com" },
          { id: "WORKER", type: "worker", title: "worker", url: "" },
        ])
      if (url.pathname.endsWith("/json/new"))
        return Response.json({ id: "PAGE_A", type: "page", title: "", url: "about:blank" })
      if (url.pathname.includes("/fs/read/output/"))
        return new Response("console.log('sandbox script')", { headers: { "content-type": "text/plain" } })
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
  if (scripts.length) {
    await db.delete(browserScriptVersion).where(inArray(browserScriptVersion.scriptId, scripts))
    await db.delete(browserScript).where(inArray(browserScript.id, scripts))
  }
  if (sessions.length) {
    await db.delete(browserSession).where(inArray(browserSession.id, sessions))
    await db.delete(relationTuple).where(inArray(relationTuple.resourceId, sessions))
  }
  if (users.length) {
    await db.delete(auditLog).where(inArray(auditLog.actorId, users))
    await db.delete(user).where(inArray(user.id, users))
  }
  // 不结束共享连接池：`src/db` 的 pool 是进程级单例，其它测试文件还要用它；
  // 由 bun test 进程退出时回收。
})

describe("浏览器 HTTP + PG 契约", () => {
  test("未登录不能访问浏览器、脚本或画面", async () => {
    for (const path of ["/sessions", "/scripts", "/sessions/ses_hidden/targets/PAGE_A/frames"])
      expect((await app.request(`/api/browser${path}`)).status).toBe(401)
  })

  test("创建会话使用工作目录、归属关系、浏览器就绪探测与唯一启动命令", async () => {
    const response = await request("/sessions", "POST", { title: "浏览器验收" })
    expect(response.status).toBe(201)
    const result = (await response.json()) as { session: { id: string }; status: string }
    expect(result.status).toBe("preparing")
    const id = result.session.id
    expect((await waitBrowser(id)).status).toBe("ready")
    expect(sessionRequests.get(id)).toMatchObject({ location: { directory: "/workspace" } })
    const [row] = await db.select().from(browserSession).where(eq(browserSession.id, id))
    expect(row?.ownerId).toBe(users[0]!)
    const [tuple] = await db
      .select()
      .from(relationTuple)
      .where(and(eq(relationTuple.resourceId, id), eq(relationTuple.relation, "owner")))
    expect(tuple?.subjectId).toBe(users[0]!)
    expect(shellCommands.get(id)).toContain("flock --close -w 45")
    // 浏览器在沙箱内，轮次结束会销毁未保活沙箱；创建时必须保活。
    expect(keepAliveCalls).toContain(id)
    const targets = (await (await request(`/sessions/${id}/targets`)).json()) as { items: unknown[] }
    expect(targets.items).toHaveLength(1)
  })

  test("跨用户访问在上游调用前返回 404", async () => {
    const id = sessions[0]!
    const count = upstreamCalls
    for (const path of [`/sessions/${id}/targets`, `/sessions/${id}/files`, `/sessions/${id}/targets/PAGE_A/frames`])
      expect((await request(path, "GET", undefined, other)).status).toBe(404)
    for (const path of [`/sessions/${id}/start`, `/sessions/${id}/targets/PAGE_A/command`])
      expect((await request(path, "POST", {}, other)).status).toBe(404)
    expect(upstreamCalls).toBe(count)
    expect(
      ((await (await request("/sessions", "GET", undefined, other)).json()) as { items: unknown[] }).items,
    ).toEqual([])
  })

  test("新标签页通过 CDP 导航，保留查询参数与片段；拒绝非 HTTP 地址", async () => {
    const id = sessions[0]!
    const url = "https://example.com/search?q=中文&limit=2#result"
    expect((await request(`/sessions/${id}/targets`, "POST", { url })).status).toBe(201)
    expect(navigated).toBe(url)
    expect((await request(`/sessions/${id}/targets`, "POST", { url: "file:///etc/passwd" })).status).toBe(400)
    expect((await request(`/sessions/${id}/targets/PAGE_A/command`, "POST", { method: "Browser.close" })).status).toBe(
      400,
    )
  })

  test("画面走鉴权 SSE、收到后 ack，取消订阅释放连接", async () => {
    const id = sessions[0]!
    const response = await request(`/sessions/${id}/targets/PAGE_A/frames`)
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    const reader = response.body!.getReader()
    let text = ""
    while (!text.includes("FRAME")) {
      const chunk = await reader.read()
      if (chunk.done) break
      text += new TextDecoder().decode(chunk.value)
    }
    expect(text).toContain("FRAME")
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(frameAcknowledged).toBe(true)
    await reader.cancel()
  })

  test("启动失败保留 PG 会话以便重试，不伪报 ready", async () => {
    failStart = true
    try {
      const body = (await (await request("/sessions", "POST", { title: "启动失败恢复" })).json()) as {
        status: string
        session: { id: string }
      }
      expect(body.status).toBe("preparing")
      const state = await waitBrowser(body.session.id)
      expect(state.status).toBe("failed")
      expect(state.error).toContain("启动失败")
      const [row] = await db.select().from(browserSession).where(eq(browserSession.id, body.session.id))
      expect(row).toBeDefined()
    } finally {
      failStart = false
    }
  })

  test("重连补齐缺失指令，保留用户自定义指令", async () => {
    const id = sessions[0]!
    overlays.delete(id)
    expect((await request(`/sessions/${id}/start`, "POST")).status).toBe(200)
    expect(overlays.get(id)).toContain("127.0.0.1:9222")
    overlays.set(id, "User customized instructions")
    expect((await request(`/sessions/${id}/start`, "POST")).status).toBe(200)
    expect(overlays.get(id)).toBe("User customized instructions")
  })

  test("表单回答按会话鉴权，保留上游验证错误", async () => {
    const id = sessions[0]!
    expect((await request(`/sessions/${id}/forms`, "GET", undefined, other)).status).toBe(404)
    expect(
      (await request(`/sessions/${id}/forms/frm_test/reply`, "POST", { answer: { approve: true } }, other)).status,
    ).toBe(404)
    const forms = (await (await request(`/sessions/${id}/forms`)).json()) as { data: unknown[] }
    expect(forms.data).toHaveLength(1)
    expect((await request(`/sessions/${id}/forms/frm_test/reply`, "POST", { answer: { approve: true } })).status).toBe(
      200,
    )
    expect(repliedAnswer).toEqual({ approve: true })
    expect((await request(`/sessions/${id}/forms/frm_test/reply`, "POST", { answer: { approve: false } })).status).toBe(
      400,
    )
    expect((await request(`/sessions/${id}/forms/frm_test/reply`, "POST", { answer: { invalid: {} } })).status).toBe(
      400,
    )
  })

  test("私有脚本不可越权读取、修改、追加版本或删除", async () => {
    const res = await request("/scripts", "POST", { name: "私有脚本", source: { content: "console.log(1)" } })
    expect(res.status).toBe(201)
    const script = (await res.json()) as { id: string }
    scripts.push(script.id)
    expect((await request(`/scripts/${script.id}`, "GET", undefined, other)).status).toBe(404)
    expect((await request(`/scripts/${script.id}`, "PATCH", { name: "窃取" }, other)).status).toBe(404)
    expect(
      (
        await request(
          `/scripts/${script.id}/versions`,
          "POST",
          { expectedVersion: 1, source: { content: "bad" } },
          other,
        )
      ).status,
    ).toBe(404)
    expect((await request(`/scripts/${script.id}`, "DELETE", undefined, other)).status).toBe(404)
    expect(((await (await request("/scripts", "GET", undefined, other)).json()) as { items: unknown[] }).items).toEqual(
      [],
    )
  })

  test("公开脚本可读可运行，不允许其他用户改写", async () => {
    const id = scripts[0]!
    expect((await request(`/scripts/${id}`, "PATCH", { visibility: "public" })).status).toBe(200)
    expect((await request(`/scripts/${id}`, "GET", undefined, other)).status).toBe(200)
    const response = await request("/sessions", "POST", { title: "执行公开流程", scriptId: id }, other)
    expect(response.status).toBe(201)
    const body = (await response.json()) as { session: { id: string }; status: string }
    expect((await waitBrowser(body.session.id, other)).status).toBe("ready")
    expect(shellCommands.get(body.session.id)).toContain("base64 -d")
    expect((await request(`/scripts/${id}`, "DELETE", undefined, other)).status).toBe(404)
  })

  test("并发追加版本只能成功一次；版本与主表在 PG 内原子一致", async () => {
    const id = scripts[0]!
    const body = { expectedVersion: 1, source: { content: "console.log(2)" }, changelog: "更新" }
    const responses = await Promise.all([
      request(`/scripts/${id}/versions`, "POST", body),
      request(`/scripts/${id}/versions`, "POST", body),
    ])
    expect(responses.map((res) => res.status).sort()).toEqual([201, 409])
    const [row] = await db.select().from(browserScript).where(eq(browserScript.id, id))
    const versions = await db.select().from(browserScriptVersion).where(eq(browserScriptVersion.scriptId, id))
    expect(row?.version).toBe(2)
    expect(versions).toHaveLength(2)
    const version = (await (await request(`/scripts/${id}/versions/1`)).json()) as { content: string }
    expect(version.content).toBe("console.log(1)")
  })

  test("脚本来源互斥、文件路径穿越、空脚本和超限内容都被拒绝", async () => {
    const cases = [
      { content: "" },
      { content: "你".repeat(90000) },
      { sessionId: sessions[0], fileName: "../../secret.js" },
      { content: "good", sessionId: sessions[0], fileName: "script.js" },
    ]
    for (const source of cases)
      expect((await request("/scripts", "POST", { name: "错误脚本", source })).status).toBe(400)
    expect(
      (
        await request(
          "/scripts",
          "POST",
          { name: "其他用户文件", source: { sessionId: sessions[0], fileName: "script.js" } },
          other,
        )
      ).status,
    ).toBe(404)
  })

  test("从同会话沙箱发布；软删除后脚本与历史版本均不可访问", async () => {
    const res = await request("/scripts", "POST", {
      name: "沙箱发布",
      source: { sessionId: sessions[0], fileName: "中文流程.js" },
    })
    expect(res.status).toBe(201)
    const script = (await res.json()) as { id: string }
    scripts.push(script.id)
    const detail = (await (await request(`/scripts/${script.id}`)).json()) as { content: string }
    expect(detail.content).toContain("sandbox script")
    expect((await request(`/scripts/${script.id}`, "DELETE")).status).toBe(200)
    expect((await request(`/scripts/${script.id}`)).status).toBe(404)
    expect((await request(`/scripts/${script.id}/versions/1`)).status).toBe(404)
    const [row] = await db.select().from(browserScript).where(eq(browserScript.id, script.id))
    expect(row?.deletedAt).toBeNumber()
  })

  test("删除浏览器会话后，沙箱代理不再可达", async () => {
    const id = sessions[0]!
    expect((await request(`/sessions/${id}`, "DELETE", undefined, other)).status).toBe(404)
    expect((await request(`/sessions/${id}`, "DELETE")).status).toBe(200)
    expect((await request(`/sessions/${id}/targets`)).status).toBe(404)
    const [row] = await db.select().from(browserSession).where(eq(browserSession.id, id))
    expect(row?.deletedAt).toBeNumber()
  })

  test("只读共享用户能观察但不能控制浏览器", async () => {
    const id = sessions[1]!
    await writeTuples(db, [
      { resourceType: "session", resourceId: id, relation: "viewer", subjectType: "user", subjectId: users[1]! },
    ])
    expect((await request(`/sessions/${id}/targets`, "GET", undefined, other)).status).toBe(200)
    const before = upstreamCalls
    expect(
      (
        await request(
          `/sessions/${id}/targets/PAGE_A/command`,
          "POST",
          { method: "Input.insertText", params: { text: "forbidden" } },
          other,
        )
      ).status,
    ).toBe(404)
    expect((await request(`/sessions/${id}/start`, "POST", undefined, other)).status).toBe(404)
    expect(upstreamCalls).toBe(before)
  })

  test("SaaS 会话已回收时仍可删除历史记录", async () => {
    const id = sessions[1]!
    missingSessions.add(id)
    expect((await request(`/sessions/${id}`, "DELETE")).status).toBe(200)
    const [row] = await db.select().from(browserSession).where(eq(browserSession.id, id))
    expect(row?.deletedAt).toBeNumber()
  })
})

test("CDP 目标和命令白名单阻止任意协议访问", () => {
  for (const target of ["../browser", "a/b", "?token", "", "a".repeat(129)]) expect(validTarget(target)).toBe(false)
  expect(validTarget("A1_B-2")).toBe(true)
  expect(allowedCdpMethod("Input.insertText")).toBe(true)
  expect(allowedCdpMethod("Browser.close")).toBe(false)
  expect(allowedCdpMethod("Runtime.evaluate")).toBe(false)
})

test("沙箱运行时探测兼容各后端模板，缺失时给出可操作错误", () => {
  const probe = parseBrowserProbe(
    ["SCRIPT=/opt/cdp-browser/cdp-browser.sh", "BROWSER=chromium", "GATEWAY=1", "NODE=1", "FLOCK=1", "PROBE_DONE"].join(
      "\n",
    ),
  )
  expect(probe).toEqual({
    script: "/opt/cdp-browser/cdp-browser.sh",
    browser: "chromium",
    gateway: true,
    node: true,
    flock: true,
  })
  expect(planBrowserLaunch(probe)).toEqual({ steps: ["/opt/cdp-browser/cdp-browser.sh start"] })

  // 只预装 Chromium（自建模板）：下发网关后启动。
  const chromiumOnly = parseBrowserProbe(["BROWSER=google-chrome-stable", "GATEWAY=1", "NODE=1"].join("\n"))
  const plan = planBrowserLaunch(chromiumOnly)
  expect("steps" in plan && plan.steps.length === 1).toBe(true)
  expect("assets" in plan && plan.assets?.length).toBe(1)
  expect("steps" in plan && plan.steps[0].includes("CHROME=google-chrome-stable")).toBe(true)
  expect("steps" in plan && plan.steps[0].includes("CDP_GATEWAY_PORT=9222")).toBe(true)

  // 云端官方模板（无 Chromium、有 node）：默认报错，允许自举时安装。
  const empty = parseBrowserProbe(["NODE=1", "FLOCK=1", "PROBE_DONE"].join("\n"))
  expect(planBrowserLaunch(empty)).toEqual({ error: expect.stringContaining("未安装 Chromium") })
  const bootstrap = planBrowserLaunch(empty, { autoInstall: true })
  expect("steps" in bootstrap && bootstrap.steps.length === 2).toBe(true)
  expect("steps" in bootstrap && bootstrap.steps[0].includes("playwright install")).toBe(true)
  expect("steps" in bootstrap && bootstrap.steps[0].includes("chromium")).toBe(true)
  expect("steps" in bootstrap && bootstrap.steps[1].includes("CDP_GATEWAY_PORT=9222")).toBe(true)
  expect("assets" in bootstrap && bootstrap.assets?.length).toBe(1)

  // 有 Chromium 但无 node：无法运行网关，必须显式失败。
  const noNode = parseBrowserProbe(["BROWSER=chromium"].join("\n"))
  expect(planBrowserLaunch(noNode)).toEqual({ error: expect.stringContaining("缺少 node") })

  // 运维覆盖优先于自动探测（其他后端可先装运行时再启动）。
  expect(planBrowserLaunch(empty, { override: "  /usr/local/bin/setup-browser.sh  " })).toEqual({
    steps: ["/usr/local/bin/setup-browser.sh"],
  })

  expect(BROWSER_PROBE).toContain("/opt/cdp-browser/cdp-browser.sh")
  expect(lockBrowserCommand("echo hi", true)).toContain("flock --close -w 45")
  expect(lockBrowserCommand("echo hi", false)).toBe("bash -c 'echo hi'")
  // 单引号命令必须安全转义，避免 shell 注入。
  expect(lockBrowserCommand("echo 'x'", true)).toContain("'\\''")
  // 云端 5xx 可重试；参数/权限错误不能重试。
  expect(isTransientSandboxFailure(new Error("Sandbox execution failed: 502: temporary error"))).toBe(true)
  expect(isTransientSandboxFailure(new Error("ECONNRESET"))).toBe(true)
  expect(isTransientSandboxFailure(new Error("invalid_request"))).toBe(false)
})

test("内联 CDP 网关与仓库源文件一致，避免两处漂移", () => {
  const source = readFileSync(resolve(import.meta.dir, "../../containers/sandbox/opt/cdp-browser/cdp-gateway.mjs"))
  expect(Buffer.from(CDP_GATEWAY_BASE64, "base64").toString("utf8")).toBe(source.toString("utf8"))
  // 分块上传必须可无损还原，且单块远小于云端命令长度限制。
  const chunks = chunkBase64(source.toString("utf8"))
  expect(chunks.length).toBeGreaterThan(1)
  expect(chunks.every((chunk) => chunk.length <= 1200)).toBe(true)
  expect(Buffer.from(chunks.join(""), "base64").toString("utf8")).toBe(source.toString("utf8"))
  // 后台启动不能生成 `&;`（bash 语法错误）。
  const plan = planBrowserLaunch({ browser: "chromium", node: true, gateway: false, flock: true })
  expect("steps" in plan && !plan.steps.join(" ").includes("&;")).toBe(true)
})
