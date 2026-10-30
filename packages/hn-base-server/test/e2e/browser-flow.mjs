// 真实 Docker SaaS → OpenSandbox → Chromium；测试专属 schema，保存结果与画面，不记录凭据。
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdirSync, writeFileSync } from "node:fs"
import { Pool } from "pg"

const base = process.env.BASE ?? "http://localhost:15301"
const saas = process.env.SAAS ?? "http://localhost:15296"
const schema = process.env.BASE_DATABASE_SCHEMA ?? "hn_browser_verify_20261028"
assert(/^hn_browser_[a-z0-9_]+$/.test(schema), "只允许浏览器验收专用 schema")
const out = process.env.BROWSER_OUT ?? "artifacts/browser-use-20261028"
mkdirSync(out, { recursive: true })
const pool = new Pool({
  connectionString: process.env.BASE_DATABASE_URL ?? "postgres://postgres:ab123456@127.0.0.1:5432/opencode-v2-up",
})
const saasPool = new Pool({
  connectionString:
    process.env.SAAS_DATABASE_URL ?? "postgres://postgres:ab123456@127.0.0.1:5432/opencode-v2-browser-test",
})
const basic = {
  authorization: `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD ?? "ab123456"}`).toString("base64")}`,
  "content-type": "application/json",
}
// 云端沙箱（E2B/阿里云）无法解析宿主的 host.docker.internal，必须把测试页放进沙箱自身。
const pageMode = process.env.PAGE_MODE ?? "host"
const pageHtml = `<!doctype html><html lang="zh"><meta charset="utf-8"><title>浏览器迁移验收</title><body style="font-family:system-ui;background:#faf9f7"><h1 style="margin:20px 40px">Browser Use · 实际页面验收</h1><input aria-label="验收输入" id="text" style="position:absolute;left:40px;top:80px;width:300px;height:40px" placeholder="输入验收标记"><button id="submit" style="position:absolute;left:40px;top:140px;width:140px;height:40px" onclick="document.title='验收通过 '+document.getElementById('text').value">确认</button><p style="position:absolute;left:40px;top:200px">用于验证实时画面、中文输入和点击。</p></body></html>`
const page = createServer((_req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8")
  res.end(pageHtml)
})
if (pageMode === "host") await new Promise((resolve) => page.listen(15303, "0.0.0.0", resolve))
const pageUrl = pageMode === "sandbox" ? "http://127.0.0.1:8080/" : "http://host.docker.internal:15303"

/** 直连 SaaS 执行一条沙箱命令，并等待对应 shell.ended（V2 只认命令文本匹配）。 */
async function saasShell(sessionId, command, timeoutMs = 180_000) {
  const started = await fetch(`${saas}/api/session/${encodeURIComponent(sessionId)}/shell`, {
    method: "POST",
    headers: basic,
    body: JSON.stringify({ command, timeoutSeconds: Math.ceil(timeoutMs / 1000) }),
  })
  assert(started.ok, `shell: ${started.status} ${(await started.text()).slice(0, 300)}`)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const response = await fetch(
      `${saas}/api/experimental/session/${encodeURIComponent(sessionId)}/log?follow=false&after=0`,
      {
        headers: basic,
      },
    )
    const text = await response.text()
    const events = []
    if (text.trim().startsWith("[")) {
      try {
        events.push(...JSON.parse(text))
      } catch {
        /* ignore */
      }
    } else
      for (const line of text.split("\n"))
        if (line.startsWith("data:"))
          try {
            events.push(JSON.parse(line.slice(5).trim()))
          } catch {
            /* heartbeat */
          }
    const ended = events.find((event) => event.type === "session.shell.ended" && event.data?.shell?.command === command)
    if (ended?.data?.shell) {
      const output = ended.data.shell.output?.output ?? ended.data.output?.output ?? ""
      assert.equal(ended.data.shell.exit, 0, `沙箱命令失败：${output.slice(-500)}`)
      return output
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`沙箱命令超时：${command.slice(0, 80)}`)
}

/** 在沙箱内起一个只服务测试页的本地 HTTP 服务（云端沙箱同样适用）。 */
async function prepareSandboxPage(sessionId) {
  const server = [
    'const http = require("node:http")',
    `const html = ${JSON.stringify(pageHtml)}`,
    'http.createServer((req, res) => { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(html) }).listen(8080, "127.0.0.1")',
  ].join("\n")
  await saasShell(
    sessionId,
    [
      // 不能用 pkill -f 匹配本文件：该 shell 自己的命令行也含这个字符串，会被一起杀掉。
      'if [ -f /tmp/opencode-test-page.pid ]; then kill "$(cat /tmp/opencode-test-page.pid)" 2>/dev/null || true; rm -f /tmp/opencode-test-page.pid; fi',
      `printf '%s' ${JSON.stringify(Buffer.from(server).toString("base64"))} | base64 -d > /tmp/opencode-test-page.js`,
      "setsid nohup node /tmp/opencode-test-page.js >/tmp/opencode-test-page.log 2>&1 &",
      "sleep 0.2; pgrep -f '^node /tmp/opencode-test-page' | head -1 > /tmp/opencode-test-page.pid",
      "for i in $(seq 1 20); do curl -sf -o /dev/null http://127.0.0.1:8080/ && echo PAGE_READY && exit 0; sleep 0.5; done",
      "cat /tmp/opencode-test-page.log; exit 1",
    ].join("\n"),
  )
}

let token,
  sid,
  scriptId,
  unsubscribe,
  modelResult,
  codeModeActive = false,
  modelText = "",
  modelToolEvidence = ""
const toolNames = new Set()
const results = []
let passed = false,
  failure = null
const save = (name, value) => writeFileSync(`${out}/${name}.json`, JSON.stringify(value, null, 2))
async function api(path, method = "GET", body, auth = token) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(900_000),
  })
  const text = await res.text()
  assert(res.ok, `${method} ${path}: ${res.status} ${text.slice(0, 400)}`)
  return text ? JSON.parse(text) : null
}
async function watch(id) {
  const controller = new AbortController()
  let connected
  const ready = new Promise((resolve) => {
    connected = resolve
  })
  const response = await fetch(`${saas}/api/session/${id}/event`, { headers: basic, signal: controller.signal })
  assert.equal(response.status, 200)
  const events = []
  const pump = (async () => {
    const reader = response.body.getReader(),
      decoder = new TextDecoder()
    let buffer = ""
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })
        let boundary
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          for (const line of block.split("\n")) {
            if (!line.startsWith("data:")) continue
            let event
            try {
              event = JSON.parse(line.slice(5))
            } catch {
              continue
            }
            if (event.type === "server.connected") connected()
            events.push(event)
            if (event.type === "session.instructions.updated" && event.data?.delta?.["core/codemode"])
              codeModeActive = true
            if (event.type === "session.text.ended") modelText += event.data?.text ?? ""
            if (event.type === "session.tool.success") modelToolEvidence += JSON.stringify(event.data?.content ?? [])
            if (event.type === "session.tool.input.started")
              toolNames.add(event.data?.name ?? event.data?.tool?.name ?? event.data?.tool)
            if (!/\.delta$|streamed$|usage\.updated/.test(event.type))
              console.log(`实时 SSE：${event.type} ${JSON.stringify(event.data ?? {}).slice(0, 350)}`)
            if (/^session\.execution\.(succeeded|failed|interrupted)$/.test(event.type)) modelResult = event
          }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error
    } finally {
      reader.releaseLock()
    }
  })()
  await ready
  return async () => {
    controller.abort()
    await pump
    save("session-events", events)
  }
}
async function firstFrame(id, target, filename) {
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 30_000)
  try {
    const response = await fetch(`${base}/api/browser/sessions/${id}/targets/${target}/frames`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
    assert.equal(response.status, 200)
    const reader = response.body.getReader(),
      decoder = new TextDecoder()
    let buffer = ""
    while (true) {
      const chunk = await reader.read()
      assert(!chunk.done, "画面流不应在首帧前关闭")
      buffer += decoder.decode(chunk.value, { stream: true })
      let index
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        for (const line of block.split("\n")) {
          if (!line.startsWith("data:")) continue
          const frame = JSON.parse(line.slice(5))
          if (!frame.data) continue
          const image = Buffer.from(frame.data, "base64")
          assert(image.length > 1000, "JPEG 画面应包含真实内容")
          writeFileSync(`${out}/${filename}.jpg`, image)
          controller.abort()
          return { bytes: image.length, metadata: frame.metadata }
        }
      }
    }
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}
try {
  const email = `browser-e2e-${Date.now()}@example.com`
  const signup = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { origin: "http://localhost:15302", "content-type": "application/json" },
    body: JSON.stringify({ email, password: "ab123456", name: "浏览器验收" }),
  })
  assert.equal(signup.status, 200)
  token = signup.headers.get("set-auth-token")
  const identity = await signup.json()
  assert(token)
  const created = await api("/api/browser/sessions", "POST", { title: "Browser Use 实际沙箱验收" })
  sid = created.session.id
  save("created", created)
  // 云端模板自举可能数分钟：创建只返回 preparing，轮询准备状态。
  let status = created.status ?? (created.ready ? "ready" : "preparing")
  const readyDeadline = Date.now() + 900_000
  while (status === "preparing" && Date.now() < readyDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 3000))
    const state = await api(`/api/browser/sessions/${sid}/browser`)
    status = state.status
    if (status === "failed") throw new Error(state.error ?? "浏览器准备失败")
    console.log(`准备状态：${status}`)
  }
  assert.equal(status, "ready", "浏览器应在超时前就绪")
  console.log(`测试会话：${sid}`)
  unsubscribe = await watch(sid)
  results.push({ name: "创建真实会话与浏览器", passed: true })
  await api(`/api/browser/sessions/${sid}/start`, "POST")
  if (pageMode === "sandbox") {
    await prepareSandboxPage(sid)
    results.push({ name: "沙箱内自托管测试页", passed: true })
  }
  const target = await api(`/api/browser/sessions/${sid}/targets`, "POST", { url: pageUrl })
  assert(target.id)
  const frame = await firstFrame(sid, target.id, "live-browser")
  results.push({ name: "控制面代理与实时 JPEG 画面", passed: true, ...frame })
  const command = (method, params) =>
    api(`/api/browser/sessions/${sid}/targets/${target.id}/command`, "POST", { method, params })
  await command("Input.dispatchMouseEvent", { type: "mousePressed", x: 100, y: 100, button: "left", clickCount: 1 })
  await command("Input.dispatchMouseEvent", { type: "mouseReleased", x: 100, y: 100, button: "left", clickCount: 1 })
  await command("Input.insertText", { text: "中文接管验证" })
  await command("Input.dispatchMouseEvent", { type: "mousePressed", x: 100, y: 160, button: "left", clickCount: 1 })
  await command("Input.dispatchMouseEvent", { type: "mouseReleased", x: 100, y: 160, button: "left", clickCount: 1 })
  let actual
  for (let attempt = 0; attempt < 10; attempt++) {
    actual = await api(`/api/browser/sessions/${sid}/targets`)
    if (actual.items.some((item) => item.title === "验收通过 中文接管验证")) break
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  assert(
    actual.items.some((item) => item.title === "验收通过 中文接管验证"),
    JSON.stringify(actual),
  )
  await firstFrame(sid, target.id, "after-input")
  results.push({ name: "真实页面中文输入与点击", passed: true })
  const script = await api("/api/browser/scripts", "POST", {
    name: "实际浏览器脚本验收",
    visibility: "private",
    source: { content: "console.log('browser-e2e')" },
  })
  scriptId = script.id
  await api(`/api/browser/scripts/${scriptId}/versions`, "POST", {
    expectedVersion: 1,
    source: { content: "console.log('browser-e2e-v2')" },
    changelog: "真实 PG 版本验证",
  })
  const [rows] = (await pool.query(`SELECT version FROM "${schema}".browser_script WHERE id=$1`, [scriptId])).rows
  assert.equal(rows.version, 2)
  const versions = await pool.query(
    `SELECT version FROM "${schema}".browser_script_version WHERE script_id=$1 ORDER BY version`,
    [scriptId],
  )
  assert.deepEqual(
    versions.rows.map((row) => row.version),
    [1, 2],
  )
  const ownership = await pool.query(`SELECT owner_id FROM "${schema}".browser_session WHERE id=$1`, [sid])
  assert.equal(ownership.rows[0].owner_id, identity.user.id)
  const binding = await saasPool.query("SELECT id, provider, state FROM sandbox WHERE session_id=$1", [sid])
  assert.equal(binding.rowCount, 1, "一个主会话只绑定一个沙箱")
  // 不同后端共用同一套浏览器契约；provider 由实际部署决定。
  assert.equal(binding.rows[0].provider, process.env.EXPECT_SANDBOX_PROVIDER ?? "opensandbox")
  assert.equal(binding.rows[0].state, "running")
  save("postgres-checks", {
    ownerId: ownership.rows[0].owner_id,
    scriptVersion: rows.version,
    versions: versions.rows,
    sandbox: binding.rows[0],
  })
  results.push({ name: "脚本发布、版本历史与 PG 归属", passed: true })
  if (process.env.MODEL) {
    const [providerID, modelID] = process.env.MODEL.split("/")
    const request = api(`/api/sessions/${sid}/message`, "POST", {
      model: { providerID, modelID },
      parts: [
        {
          type: "text",
          text: `请通过工具检查共享浏览器中的当前页面，告诉我页面标题，并把工具执行过程和结果保留在会话中。不要启动新浏览器，不要提问。`,
        },
      ],
    })
    let formTimer = setInterval(async () => {
      try {
        const { data: forms } = await api(`/api/browser/sessions/${sid}/forms`)
        for (const form of forms) {
          const answer = Object.fromEntries(
            form.fields.flatMap((field) =>
              field.type === "external"
                ? []
                : [
                    [
                      field.key,
                      field.default ??
                        (field.type === "boolean"
                          ? true
                          : field.type === "number" || field.type === "integer"
                            ? (field.minimum ?? 0)
                            : field.type === "multiselect"
                              ? (field.options ?? []).slice(0, 1).map((option) => option.value)
                              : (field.options?.[0]?.value ?? "继续验收")),
                    ],
                  ],
            ),
          )
          await api(`/api/browser/sessions/${sid}/forms/${form.id}/reply`, "POST", { answer })
        }
      } catch (error) {
        console.log("表单代答：", String(error).slice(0, 100))
      }
    }, 2000)
    try {
      await request
      // V2 /prompt 返回的是接收结果，不能把 HTTP 200 当作模型轮次已经结束。
      const deadline = Date.now() + 420_000
      while (!modelResult && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 500))
      assert.equal(modelResult?.type, "session.execution.succeeded", `模型轮次应成功：${JSON.stringify(modelResult)}`)
      assert(codeModeActive, "必须验证本轮加载了 Code Mode 指令")
      assert(modelText.includes("验收通过 中文接管验证"), "模型应返回真实页面标题")
      assert(modelToolEvidence.includes("验收通过 中文接管验证"), "页面标题必须有真实工具结果支撑")
      assert(!modelToolEvidence.includes("browser.disconnected"), "沙箱浏览器任务不能误用桌面浏览器通道")
      modelResult = null
      modelText = ""
      modelToolEvidence = ""
      await api(`/api/sessions/${sid}/message`, "POST", {
        model: { providerID, modelID },
        parts: [
          {
            type: "text",
            text: "继续验收：请实际调用 execute 工具运行 JavaScript：return 40 + 2; 然后只回复结果。不要调用桌面浏览器，不要提问。",
          },
        ],
      })
      const codeDeadline = Date.now() + 300_000
      while (!modelResult && Date.now() < codeDeadline) await new Promise((resolve) => setTimeout(resolve, 500))
      assert.equal(modelResult?.type, "session.execution.succeeded", "Code Mode 轮次应成功")
      assert(toolNames.has("execute"), "必须实际调用 Code Mode execute，不只检查配置")
      assert(modelToolEvidence.includes("42") && modelText.includes("42"), "Code Mode 应返回真实计算结果 42")
    } finally {
      clearInterval(formTimer)
    }
    results.push({ name: "真实模型工具执行与 SSE", passed: true, codeModeActive, tools: [...toolNames] })
  }
  await api(`/api/browser/sessions/${sid}/targets/${target.id}`, "DELETE")
  results.push({ name: "关闭标签页", passed: true })
  passed = true
} catch (error) {
  failure = { error: String(error), stack: error.stack }
  console.error(error)
  process.exitCode = 1
} finally {
  const cleanupErrors = []
  if (unsubscribe) await unsubscribe().catch((error) => cleanupErrors.push(String(error)))
  if (scriptId) {
    try {
      await api(`/api/browser/scripts/${scriptId}`, "DELETE")
      const row = await pool.query(`SELECT deleted_at FROM "${schema}".browser_script WHERE id=$1`, [scriptId])
      assert(row.rows[0]?.deleted_at, "脚本软删除应持久化")
    } catch (error) {
      cleanupErrors.push(`脚本清理：${String(error)}`)
    }
  }
  if (sid && !process.env.KEEP_BROWSER) {
    try {
      await api(`/api/browser/sessions/${sid}`, "DELETE")
      const row = await pool.query(`SELECT deleted_at FROM "${schema}".browser_session WHERE id=$1`, [sid])
      const binding = await saasPool.query("SELECT state FROM sandbox WHERE session_id=$1", [sid])
      assert(row.rows[0]?.deleted_at, "历史软删除应持久化")
      assert(
        binding.rows.every((item) => item.state === "destroyed" || item.state === "killed"),
        "测试沙箱必须完成回收",
      )
      results.push({ name: "PG 删除状态与沙箱回收", passed: true })
    } catch (error) {
      cleanupErrors.push(`会话清理：${String(error)}`)
    }
  }
  if (pageMode === "host") await new Promise((resolve) => page.close(resolve))
  await Promise.all([pool.end(), saasPool.end()])
  const result = { passed: passed && cleanupErrors.length === 0, sessionId: sid, results, ...failure, cleanupErrors }
  save("result", result)
  console.log(JSON.stringify(result))
  if (!result.passed) process.exitCode = 1
}
