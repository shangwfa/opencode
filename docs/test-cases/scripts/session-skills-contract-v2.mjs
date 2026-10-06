// V2 Session Skills 契约执行脚本（docs/test-cases/skills/session-skills.md 全用例）。
// 专用PG + 专用SaaS容器（只读挂载源码 + provider配置）+ 远端OpenSandbox经本机转发与测试代理。
// 用例失败即停止并保留证据；不重放失败请求来"修复"结果。
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { toolCalls } from "./session-skills-events.mjs"

const root = path.resolve(import.meta.dir, "../../..")
const mode = process.env.PROBE_PERSIST_MODE ?? "pvc"
assert(["pvc", "snapshot"].includes(mode))
const nonce = crypto.randomUUID().slice(0, 8)
const databaseName = `opencode-v2-skills-contract-${Date.now()}-${nonce}`
const runID = `skills-contract-${mode}-${Date.now()}-${nonce}`
const container = `opencode-${runID}`
const port = Number(process.env.PROBE_PORT ?? 14131)
const out = path.join(root, "docs/test-cases/sandbox/store/evidence", runID)
mkdirSync(out, { recursive: true })
const report = {
  runID,
  databaseName,
  mode,
  passed: false,
  cases: [],
  sessions: [],
  sourceSha256: {},
  platformRequests: [],
  workspaceReadinessFailures: 0,
}
const save = () => writeFileSync(path.join(out, "result.json"), JSON.stringify(report, null, 2))
const hash = (s) => createHash("sha256").update(s).digest("hex")
let currentCase = null
const begin = (id) => {
  currentCase = { id, passed: false }
  report.cases.push(currentCase)
  save()
}
const pass = (evidence = {}) => {
  assert(currentCase, "case context missing")
  currentCase.passed = true
  currentCase.evidence = evidence
  save()
  console.log(JSON.stringify({ case: currentCase.id, passed: true }))
}
const fail = (error) => {
  if (currentCase) {
    currentCase.passed = false
    currentCase.error = String(error)
    save()
    console.log(JSON.stringify({ case: currentCase.id, passed: false, error: String(error) }))
  }
  throw error instanceof Error ? error : new Error(String(error))
}

const config = JSON.parse(
  execFileSync("docker", ["inspect", process.env.PROBE_SOURCE_CONTAINER ?? "opencode-saas-test"], { encoding: "utf8" }),
)[0]
const env = Object.fromEntries(
  config.Config.Env.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
)
// PROBE_UPSTREAM 直连真实平台时，本机 30040 转发进程不再是依赖：
// 独立转发进程会被会话清理/误杀，曾在整轮验收中途退出导致连锁环境性失败。
const upstream =
  process.env.PROBE_UPSTREAM ??
  `${env.OPENCODE_SANDBOX_PROTOCOL ?? "http"}://${env.OPENCODE_SANDBOX_DOMAIN.replace("host.docker.internal", "127.0.0.1")}`
// 平台可达性前置检查：建库/起容器前先拨测，失败立即终止，不把环境故障烧成用例失败。
{
  const reachable = await fetch(upstream, { signal: AbortSignal.timeout(5000) }).then(
    () => true,
    (cause) => cause,
  )
  if (reachable !== true)
    throw new Error(
      `OpenSandbox 平台不可达（${upstream}）：${String(reachable)}。检查网络或显式设置 PROBE_UPSTREAM 后重试`,
    )
}
const url = new URL(process.env.OPENCODE_DATABASE_URL ?? "")
assert(/test|lifecycle/.test(url.pathname), "只允许专用测试PG")
url.pathname = `/${databaseName}`
const db = new Bun.SQL(url.toString())
const base = `http://127.0.0.1:${port}`
// 新镜像默认启用 Basic auth 并生成随机密码。测试容器注入一次性密码，
// 避免依赖旧镜像的无密码行为，也保证 API 请求与容器配置一致。
const serverPassword = process.env.OPENCODE_PASSWORD ?? crypto.randomUUID()
const headers = {
  "Content-Type": "application/json",
  Authorization:
    "Basic " + Buffer.from(`opencode:${serverPassword}`).toString("base64"),
}
const model = {
  providerID: process.env.MODEL_PROVIDER ?? env.MODEL_PROVIDER ?? "Yd-DeepSeek",
  id: process.env.MODEL_ID ?? env.MODEL_ID ?? "deepseek-v4-flash",
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function request(method, route, payload, timeoutMs = 300000) {
  const response = await fetch(base + route, {
    method,
    headers,
    body: payload === undefined ? undefined : JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null }
}
async function api(method, route, payload) {
  const result = await request(method, route, payload)
  assert(
    result.status >= 200 && result.status < 300,
    `${method} ${route}: ${result.status} ${JSON.stringify(result.body).slice(0, 250)}`,
  )
  return result.body
}
async function waitUntil(read, predicate, timeout = 180000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await read()
    if (predicate(result)) return result
    await sleep(300)
  }
  throw new Error("接口验收条件等待超时")
}
async function command(sid, script) {
  const marker = `EXEC_${crypto.randomUUID()}`
  const control = new AbortController()
  const response = await fetch(base + `/api/session/${sid}/event`, { headers, signal: control.signal })
  assert(response.ok && response.body)
  const reader = response.body.getReader()
  let ended, error
  const pump = (async () => {
    let buffer = ""
    const decoder = new TextDecoder()
    try {
      while (!ended) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })
        let index
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index).trim()
          buffer = buffer.slice(index + 1)
          if (!line.startsWith("data:")) continue
          let event
          try {
            event = JSON.parse(line.slice(5).trim())
          } catch {
            continue
          }
          const output = event.data?.output
          const text = typeof output === "string" ? output : String(output?.output ?? "")
          if (event.type === "session.shell.ended" && text.includes(marker)) ended = { event, text }
        }
      }
    } catch (cause) {
      if (!control.signal.aborted) error = cause
    }
  })()
  try {
    await api("POST", `/api/session/${sid}/shell`, {
      command: `set -eu; ${script}; echo ${marker}`,
      timeoutSeconds: 120,
    })
    await waitUntil(
      async () => {
        if (error) throw error
        return ended
      },
      Boolean,
      120000,
    )
    assert.equal(ended.event.data.shell.exit, 0)
    return ended.text.replace(marker, "").trim()
  } finally {
    control.abort()
    await reader.cancel().catch(() => {})
    await pump
  }
}
// 消费 prompt_stream；成功 admission 且 resume:false 使用 promptOnce。
let promptSequence = 0
async function promptStream(sid, payload, timeoutMs = 300000) {
  const sequence = ++promptSequence
  const evidenceFile = path.join(out, `prompt-${sequence}.json`)
  console.log(JSON.stringify({ phase: currentCase?.id, prompt: sequence, sid, text: payload.text }))
  const started = performance.now()
  const response = await fetch(`${base}/api/session/${sid}/prompt_stream`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model, metadata: {}, delivery: "queue", ...payload }),
    signal: AbortSignal.timeout(timeoutMs + 30000),
  })
  if (response.status !== 200) {
    const text = await response.text().catch(() => "")
    return { status: response.status, error: text.slice(0, 600), events: [] }
  }
  const reader = response.body.getReader()
  const events = []
  let buffer = "",
    done = false,
    streamError
  const pump = (async () => {
    const decoder = new TextDecoder()
    try {
      while (!done) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })
        let index
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index).trim()
          buffer = buffer.slice(index + 1)
          if (!line.startsWith("data:")) continue
          let event
          try {
            event = JSON.parse(line.slice(5).trim())
          } catch {
            continue
          }
          events.push(event)
          if (["session.execution.succeeded", "session.execution.failed"].includes(event.type)) done = true
        }
      }
    } catch (error) {
      if (!streamError) streamError = error
    }
  })()
  const deadline = Date.now() + timeoutMs
  // 自动应答 question 表单：自动化验收没有真人，模型提问（如选测试框架）会永久阻塞执行。
  // 应答策略取每个字段的第一个选项（question 工具约定推荐项排在首位）；无选项的自由字段给确定性默认值。
  const formAnswers = []
  let lastFormCheck = 0
  // 诊断快照：表单自动应答未命中时，需要区分“列表为空”与“过滤条件不匹配”。
  let formEmptyLists = 0
  const formSnapshots = []
  const answerForms = async () => {
    try {
      const list = await request("GET", `/api/session/${sid}/form`, undefined, 10000)
      const forms = list.body?.data ?? []
      if (!Array.isArray(forms) || forms.length === 0) formEmptyLists++
      else if (formSnapshots.length < 10)
        formSnapshots.push({
          httpStatus: list.status,
          bodyKeys: Object.keys(list.body ?? {}),
          forms: forms.slice(0, 3).map((form) => ({
            id: form.id,
            status: form.status ?? form.state?.status,
            kind: form.metadata?.kind,
            sessionID: form.sessionID,
          })),
        })
      for (const form of forms) {
        // session.form.list already returns only pending forms; Form.Info has no
        // top-level status (it lives on Form.Detail). Checking form.status here
        // silently skipped every question form and stalled executions to timeout.
        if (form.metadata?.kind !== "question") continue
        const answer = {}
        for (const field of form.fields ?? []) {
          // Answers must satisfy Form.Value (string|number|boolean|string[]):
          // a text fallback for number/boolean/multiselect fields is rejected 400.
          if (field.type === "external") continue
          if (field.type === "boolean") answer[field.key] = field.default ?? true
          else if (field.type === "number" || field.type === "integer")
            answer[field.key] = field.default ?? field.minimum ?? 1
          else if (field.type === "multiselect")
            answer[field.key] = [field.options?.[0]?.value ?? field.default?.[0]].filter(Boolean)
          else answer[field.key] = field.options?.[0]?.value ?? field.default ?? "由验收器代答：请按推荐方案继续"
        }
        // 400 twice means the constructed answer cannot validate; retrying forever
        // starves the interview until the watchdog cancels the form.
        const failures = formAnswers.filter((item) => item.formID === form.id && item.status === 400).length
        if (failures >= 2) {
          if (failures === 2) formAnswers.push({ formID: form.id, skipped: true, fields: form.fields?.map((f) => ({ key: f.key, type: f.type })) })
          continue
        }
        const replied = await request("POST", `/api/session/${sid}/form/${form.id}/reply`, { answer }, 10000)
        formAnswers.push({ formID: form.id, answer, status: replied.status })
      }
    } catch {}
  }
  while (!done && Date.now() < deadline && !streamError) {
    await sleep(200)
    if (Date.now() - lastFormCheck >= 2000) {
      lastFormCheck = Date.now()
      await answerForms()
    }
  }
  if (!done && !streamError) streamError = new Error("prompt_stream 等待执行终止超时")
  let pendingPermissions
  if (streamError) {
    try {
      pendingPermissions = await request("GET", `/api/session/${sid}/permission`, undefined, 10000)
    } catch (error) {
      pendingPermissions = { error: String(error) }
    }
  }
  writeFileSync(
    evidenceFile,
    JSON.stringify(
      { sid, payload, events, error: streamError && String(streamError), pendingPermissions, formAnswers, formEmptyLists, formSnapshots },
      null,
      2,
    ),
  )
  try {
    await reader.cancel()
  } catch {}
  await pump
  if (streamError) throw streamError
  return { status: 200, events, elapsedMs: performance.now() - started }
}
const textOf = (events) =>
  events
    .filter((e) => e.type === "session.text.ended")
    .map((e) => e.data?.text ?? "")
    .join("")
// resume:false 只做 admission（不驱动执行），必须用非流式 prompt 接口。
async function promptOnce(sid, payload) {
  const started = performance.now()
  const response = await request("POST", `/api/session/${sid}/prompt`, payload)
  return { status: response.status, body: response.body, elapsedMs: performance.now() - started }
}
const toolEvents = (events, type) => events.filter((e) => e.type === type)
const toolText = (event) =>
  (event?.data?.content ?? [])
    .filter((c) => c?.type === "text")
    .map((c) => c.text)
    .join("")
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`

let started = false
const proxy = Bun.serve({
  hostname: "0.0.0.0",
  port: 0,
  idleTimeout: 255,
  async fetch(request, server) {
    try {
      const requestURL = new URL(request.url)
      if (
        process.env.PROBE_FAIL_WORKSPACE_READY === "true" &&
        request.method === "POST" &&
        requestURL.pathname.includes("/proxy/")
      ) {
        const body = await request.clone().text()
        if (body.includes(".opencode-ready-")) {
          if (report.workspaceReadinessFailures === 0)
            report.createsBeforeWorkspaceFailure = report.platformRequests.filter(
              (request) => request.method === "POST" && request.path === "/v1/sandboxes",
            ).length
          report.workspaceReadinessFailures++
          save()
          return Response.json(
            { code: "INJECTED_WORKSPACE_FAILURE", message: "workspace readiness transport failure" },
            { status: 503 },
          )
        }
      }
      const forwarded = new Headers(request.headers)
      forwarded.delete("host")
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        for (const name of [
          "connection",
          "upgrade",
          "sec-websocket-key",
          "sec-websocket-version",
          "sec-websocket-extensions",
        ])
          forwarded.delete(name)
        const wsURL = (upstream + requestURL.pathname + requestURL.search).replace(/^http/, "ws")
        if (
          server.upgrade(request, { data: { wsURL, headers: Object.fromEntries(forwarded), remote: null, queue: [] } })
        )
          return undefined
        return new Response("WebSocket upgrade failed", { status: 400 })
      }
      const response = await fetch(upstream + requestURL.pathname + requestURL.search, {
        method: request.method,
        headers: forwarded,
        body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer(),
        signal: AbortSignal.timeout(180000),
      })
      if (!requestURL.pathname.includes("/proxy/")) {
        report.platformRequests.push({ method: request.method, path: requestURL.pathname, status: response.status })
        save()
      }
      if (/\/endpoints\/\d+$/.test(requestURL.pathname) && response.ok) {
        const result = await response.json()
        const endpoint = new URL(`http://${result.endpoint}`)
        assert(endpoint.pathname.includes("/proxy/"), "验收要求server-proxy端点")
        const proxyHost = requestURL.hostname === "127.0.0.1" ? "127.0.0.1" : "host.docker.internal"
        result.endpoint = `${proxyHost}:${proxy.port}${endpoint.pathname}${endpoint.search}`
        return Response.json(result, { status: response.status })
      }
      return response
    } catch (error) {
      report.platformRequests.push({ error: String(error) })
      save()
      return Response.json({ message: "dedicated test proxy failed" }, { status: 502 })
    }
  },
  websocket: {
    open(socket) {
      const remote = new WebSocket(socket.data.wsURL, { headers: socket.data.headers })
      socket.data.remote = remote
      remote.addEventListener("open", () => {
        for (const message of socket.data.queue) remote.send(message)
        socket.data.queue.length = 0
      })
      remote.addEventListener("message", (event) => socket.send(event.data))
      remote.addEventListener("error", () => socket.close(1011, "upstream websocket failed"))
      remote.addEventListener("close", () => socket.close())
    },
    message(socket, message) {
      const remote = socket.data.remote
      if (remote?.readyState === WebSocket.OPEN) remote.send(message)
      else socket.data.queue.push(message)
    },
    close(socket) {
      socket.data.remote?.close()
    },
  },
})

async function bootContainer(name, portNumber, extraEnv = {}) {
  const args = ["run", "-d", "--name", name, "--no-healthcheck", "-p", `${portNumber}:4096`]
  for (const pkg of ["core", "server", "protocol"])
    args.push("-v", `${root}/packages/${pkg}/src:/app/packages/${pkg}/src:ro`)
  if (process.env.PROBE_MODEL_CONFIG)
    args.push("-v", `${process.env.PROBE_MODEL_CONFIG}:/home/opencode/.config/opencode/opencode.jsonc:ro`)
  const merged = { ...env, OPENCODE_PASSWORD: serverPassword, ...extraEnv }
  for (const [key, value] of Object.entries(merged)) args.push("-e", `${key}=${value}`)
  args.push(config.Config.Image)
  execFileSync("docker", args, { encoding: "utf8" })
}
async function waitInfo(portNumber) {
  await waitUntil(
    async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${portNumber}/api/info`, {
          headers,
          signal: AbortSignal.timeout(5000),
        })
        return response.status === 200
      } catch {
        return false
      }
    },
    Boolean,
    90000,
  )
}

async function newSession(title, withSandbox = false, extra = {}) {
  const payload = { title, location: { directory: "/workspace" }, model, ...extra }
  if (withSandbox) payload.sandbox = { cpu: "1", memory: "2Gi", image: env.OPENCODE_SANDBOX_IMAGE, persistMode: mode }
  const created = await api("POST", "/api/session", payload)
  report.sessions.push(created.data.id)
  save()
  return created.data.id
}
// V2 DELETE保护：沙箱清理未完成返回409并保留会话/恢复点；按语义有界重试到204。
async function deleteSession(sid, timeout = 240000) {
  const deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) {
    last = await request("DELETE", `/api/session/${sid}`)
    if (last.status === 204 || last.status === 404) return last.status
    assert.equal(last.status, 409, `DELETE 意外状态: ${last.status} ${JSON.stringify(last.body).slice(0, 200)}`)
    await sleep(1000)
  }
  throw new Error(`DELETE 清理等待超时: ${sid} ${JSON.stringify(last?.body).slice(0, 200)}`)
}

try {
  for (const file of [
    "skill.ts",
    "session/skills.ts",
    "session/scan.ts",
    "session/prompt.ts",
    "session/context.ts",
    "session/skill-resource.ts",
    "tool/plugin/skill.ts",
    "tool/plugin/read.ts",
    "sandbox/tools.ts",
    "sandbox/provider.ts",
    "sandbox/workspace.ts",
    "sandbox/create-lease.ts",
    "session/tool-gate.ts",
    "codemode/runner.ts",
  ])
    report.sourceSha256[file] = hash(readFileSync(path.join(root, "packages/core/src", file), "utf8"))
  const adminURL = new URL(url)
  adminURL.pathname = "/postgres"
  const admin = new Bun.SQL(adminURL.toString())
  try {
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`)
  } finally {
    await admin.close()
  }
  const dockerURL = new URL(url)
  dockerURL.hostname = "host.docker.internal"
  await bootContainer(container, port, {
    OPENCODE_DATABASE_URL: dockerURL.toString(),
    OPENCODE_SANDBOX_DOMAIN: `host.docker.internal:${proxy.port}`,
    OPENCODE_SANDBOX_USE_SERVER_PROXY: "true",
    OPENCODE_SANDBOX_VOLUME_TYPE: mode,
    OPENCODE_SESSION_AUTO_KEEPALIVE: "true",
    OPENCODE_SANDBOX_SNAPSHOT_ENABLED: "true",
    OPENCODE_SANDBOX_SNAPSHOT_WAIT_SEC: "120",
    OPENCODE_SANDBOX_SNAPSHOT_REFRESH_SEC: "1000000000",
    OPENCODE_SANDBOX_IDLE_REAP_SEC: "3600",
    OPENCODE_SANDBOX_TIMEOUT_SECONDS: "3600",
  })
  started = true
  report.container = container
  report.image = config.Config.Image
  save()
  await waitInfo(port)
  console.log(JSON.stringify({ boot: "ready", model }))

  if (process.env.PROBE_SPECIALIZED_SKILLS === "true") {
    report.testSourceSha256 = {}
    for (const file of [
      "session-skills-contract-v2.mjs",
      "session-skills-specialized-v2.mjs",
      "session-skills-events.mjs",
    ]) {
      const content = readFileSync(path.join(root, "docs/test-cases/scripts", file), "utf8")
      report.testSourceSha256[file] = hash(content)
      writeFileSync(path.join(out, `test-source-${file}`), content)
    }
    const { runSpecializedSkills } = await import("./session-skills-specialized-v2.mjs")
    await runSpecializedSkills({
      root,
      out,
      report,
      save,
      begin,
      pass,
      api,
      request,
      command,
      promptStream,
      newSession,
      deleteSession,
      waitUntil,
      db,
      model,
    })
  } else if (process.env.PROBE_FAIL_WORKSPACE_READY === "true") {
    begin("workspace-readiness-refusal")
    const sid = await newSession("workspace-readiness-refusal", true)
    const row = await waitUntil(
      async () => (await db`select id,state from sandbox where session_id=${sid}`)[0],
      (row) => report.workspaceReadinessFailures > 0 && row?.state === "destroyed",
    )
    await sleep(3500)
    assert.equal(
      report.platformRequests.filter((request) => request.method === "POST" && request.path === "/v1/sandboxes").length,
      report.createsBeforeWorkspaceFailure,
      "工作目录失败后不得自动重建",
    )
    assert(
      report.platformRequests.some(
        (request) => request.method === "DELETE" && request.path.startsWith("/v1/sandboxes/") && request.status === 204,
      ),
      "未提交的新沙箱必须补偿清理",
    )
    assert(row.id.startsWith("creating-"), "就绪失败不得发布 running 的物理代际")
    pass({ sid, source: row, injectedFailures: report.workspaceReadinessFailures })
  } else {
    // T15.1 创建简单私有 Skill
    begin("T15.1")
    {
      const sid = await newSession("contract-t15-1")
      const created = await api("POST", `/api/session/${sid}/skills`, {
        id: "reviewer",
        description: "检查除零问题",
        content: "# Reviewer\n回复 REVIEWER_OK",
      })
      assert.equal(created.source, "session")
      assert.equal(created.skill.id, "reviewer")
      assert.equal(created.skill.name, "reviewer")
      assert.deepEqual(created.resources, [])
      const rows = await db`select skill_id, name, content from session_skills where session_id=${sid}`
      assert.equal(rows.length, 1)
      assert.equal(rows[0].content, "# Reviewer\n回复 REVIEWER_OK")
      pass({ sid })
    }

    // T15.2 Bundle metadata 不泄漏正文
    begin("T15.2")
    {
      const sid = await newSession("contract-t15-2")
      await api("POST", `/api/session/${sid}/skills`, {
        id: "complex-reviewer",
        description: "数据库审查",
        content: "# Complex Reviewer",
        resources: [
          { path: "references/check.md", type: "doc", content: "SQL injection is HIGH" },
          { path: "templates/safe.py", type: "template", content: "query = ?" },
        ],
      })
      const listed = await api("GET", `/api/session/${sid}/skills`)
      const item = listed.data.find((x) => x.skill.id === "complex-reviewer")
      assert(item, "missing complex-reviewer")
      assert.deepEqual(
        item.resources.map((r) => r.path),
        ["references/check.md", "templates/safe.py"],
      )
      assert(
        item.resources.every(
          (r) => JSON.stringify(Object.keys(r).sort()) === JSON.stringify(["digest", "path", "size", "type"]),
        ),
      )
      assert(item.resources.every((r) => /^[a-f0-9]{64}$/.test(r.digest)))
      assert(!JSON.stringify(item).includes("SQL injection is HIGH"))
      const rows = await db`select resources from session_skills where session_id=${sid}`
      const raw = JSON.parse(rows[0].resources)
      assert.equal(raw.length, 2)
      assert.equal(raw[0].content, "SQL injection is HIGH")
      pass({ sid })
    }

    // T15.3 Upsert、删除与 clear 的 overlay 语义
    begin("T15.3")
    {
      const sid = await newSession("contract-t15-3")
      await api("POST", `/api/session/${sid}/skills`, {
        id: "checker",
        description: "v1",
        content: "V1",
        resources: [{ path: "a.md", type: "doc", content: "a" }],
      })
      await api("POST", `/api/session/${sid}/skills`, {
        id: "checker",
        description: "v2",
        content: "V2",
        resources: [
          { path: "b.md", type: "doc", content: "b" },
          { path: "c.md", type: "doc", content: "c" },
        ],
      })
      let listed = await api("GET", `/api/session/${sid}/skills`)
      const item = listed.data.find((x) => x.skill.id === "checker")
      assert.equal(item.skill.description, "v2")
      assert.equal(item.resources.length, 2)
      assert.equal(
        (await db`select count(*)::int as n from session_skills where session_id=${sid} and skill_id='checker'`)[0].n,
        1,
      )
      const del = await request("DELETE", `/api/session/${sid}/skills/checker`)
      assert.equal(del.status, 204)
      listed = await api("GET", `/api/session/${sid}/skills`)
      assert(!listed.data.some((x) => x.skill.id === "checker"))
      await api("POST", `/api/session/${sid}/skills`, { id: "checker2", content: "x" })
      const clear = await request("DELETE", `/api/session/${sid}/skills`)
      assert.equal(clear.status, 204)
      listed = await api("GET", `/api/session/${sid}/skills`)
      assert(!listed.data.some((x) => x.source === "session"), "clear 后不得残留 session 项")
      pass({ sid })
    }

    // T15.4 并发、隔离与级联删除
    begin("T15.4")
    {
      const sid = await newSession("contract-t15-4-race")
      await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          api("POST", `/api/session/${sid}/skills`, { id: "race-skill", description: `v${i}`, content: `# v${i}` }),
        ),
      )
      assert.equal(
        (await db`select count(*)::int as n from session_skills where session_id=${sid} and skill_id='race-skill'`)[0]
          .n,
        1,
      )
      const a = await newSession("contract-t15-4-a")
      const b = await newSession("contract-t15-4-b")
      await api("POST", `/api/session/${a}/skills`, { id: "private-skill", content: "# A only" })
      const listA = await api("GET", `/api/session/${a}/skills`)
      const listB = await api("GET", `/api/session/${b}/skills`)
      assert(listA.data.some((x) => x.skill.id === "private-skill"))
      assert(!listB.data.some((x) => x.skill.id === "private-skill"))
      const c = await newSession("contract-t15-4-cascade")
      await api("POST", `/api/session/${c}/skills`, { id: "a", content: "# A" })
      await api("POST", `/api/session/${c}/skills`, { id: "b", content: "# B" })
      assert.equal((await db`select count(*)::int as n from session_skills where session_id=${c}`)[0].n, 2)
      await deleteSession(c)
      assert.equal((await db`select count(*)::int as n from session_skills where session_id=${c}`)[0].n, 0)
      pass({ sid, a, b })
    }

    // T15.5 资源校验、编码与当前 ID 契约
    begin("T15.5")
    {
      const sid = await newSession("contract-t15-5")
      const badPayloads = [
        { id: "large", content: "# x", resources: [{ path: "big.md", type: "doc", content: "x".repeat(262145) }] },
        {
          id: "many",
          content: "# x",
          resources: Array.from({ length: 65 }, (_, i) => ({ path: `r/${i}.md`, type: "doc", content: "x" })),
        },
        {
          id: "total",
          content: "# x",
          resources: [1, 2, 3, 4, 5].map((i) => ({ path: `r${i}.md`, type: "doc", content: "x".repeat(262144) })),
        },
        { id: "bad-path", content: "# x", resources: [{ path: "../secret", type: "doc", content: "x" }] },
        { id: "abs", content: "# x", resources: [{ path: "/etc/passwd", type: "doc", content: "x" }] },
        { id: "backslash", content: "# x", resources: [{ path: "a\\b.md", type: "doc", content: "x" }] },
        { id: "empty-seg", content: "# x", resources: [{ path: "a//b.md", type: "doc", content: "x" }] },
        { id: "dot", content: "# x", resources: [{ path: "./a.md", type: "doc", content: "x" }] },
        {
          id: "dup",
          content: "# x",
          resources: [
            { path: "a.md", type: "doc", content: "x" },
            { path: "a.md", type: "doc", content: "y" },
          ],
        },
        { id: "nul", content: "# x", resources: [{ path: "a\0b.md", type: "doc", content: "x" }] },
        { id: "reserved-skill", content: "# x", resources: [{ path: "SKILL.md", type: "doc", content: "overwrite" }] },
        {
          id: "reserved-resources",
          content: "# x",
          resources: [{ path: "resources.json", type: "doc", content: "overwrite" }],
        },
        {
          id: "reserved-nested",
          content: "# x",
          resources: [{ path: "SKILL.md/nested", type: "doc", content: "overwrite" }],
        },
        {
          id: "conflict",
          content: "# x",
          resources: [
            { path: "scripts/run.sh", type: "script", content: "file" },
            { path: "scripts/run.sh/child", type: "doc", content: "conflict" },
          ],
        },
      ]
      for (const payload of badPayloads) {
        const response = await request("POST", `/api/session/${sid}/skills`, payload)
        assert.equal(response.status, 400, `预期400: ${payload.id}`)
      }
      assert.equal(
        (await db`select count(*)::int as n from session_skills where session_id=${sid}`)[0].n,
        0,
        "非法请求不得部分写入",
      )
      const okBoundary = await api("POST", `/api/session/${sid}/skills`, {
        id: "boundary",
        content: "# x",
        resources: [
          { path: "big.md", type: "doc", content: "x".repeat(262144) },
          ...Array.from({ length: 63 }, (_, i) => ({ path: `r/${i}.md`, type: "doc", content: "x" })),
        ],
      })
      assert.equal(okBoundary.resources.length, 64)
      const unicode = await api("POST", `/api/session/${sid}/skills`, {
        id: "encoding",
        content: "# Encoding",
        resources: [
          { path: "unicode.md", type: "doc", content: "中文 🎉 日本語\n<tag>" },
          { path: "binary.bin", type: "asset", content: "\u0000\u0001binary" },
        ],
      })
      assert.deepEqual(
        unicode.resources.map((r) => r.path),
        ["unicode.md", "binary.bin"],
      )
      for (const edgeId of ["中文技能", "with space", "a/b", "x".repeat(300)]) {
        const response = await request("POST", `/api/session/${sid}/skills`, { id: edgeId, content: "# x" })
        assert.equal(response.status, 200, `当前ID契约应接受: ${edgeId.slice(0, 20)}`)
      }
      pass({ sid, rejected: badPayloads.length })
    }

    // T15.6 Sandbox Skill 的发现、刷新和优先级
    let sandboxSID
    begin("T15.6")
    {
      sandboxSID = await newSession("contract-t15-6", true)
      await waitUntil(
        async () => (await db`select state from sandbox where session_id=${sandboxSID}`)[0],
        (row) => row?.state === "running",
      )
      await command(
        sandboxSID,
        [
          "mkdir -p /workspace/.opencode/skills/sandbox-demo/references",
          "printf -- '---\\nname: Sandbox Demo\\ndescription: Sandbox source\\n---\\n# Sandbox Demo\\n' > /workspace/.opencode/skills/sandbox-demo/SKILL.md",
          "printf -- '---\\ndescription: reference only\\n---\\nREFERENCE\\n' > /workspace/.opencode/skills/sandbox-demo/references/guide.md",
          "printf -- '---\\ndescription: flat skill\\n---\\n# Flat\\n' > /workspace/.opencode/skills/flat.md",
        ].join("; "),
      )
      const refreshed = await api("POST", `/api/session/${sandboxSID}/skills/refresh`)
      const sandboxIds = refreshed.data.filter((x) => x.source === "sandbox").map((x) => x.skill.id)
      assert(sandboxIds.includes("sandbox-demo"), `缺少 sandbox-demo: ${JSON.stringify(sandboxIds)}`)
      assert(sandboxIds.includes("flat"), `缺少 flat: ${JSON.stringify(sandboxIds)}`)
      assert(!sandboxIds.includes("guide"), "references/guide.md 不得提升为 skill")
      const demo = refreshed.data.find((x) => x.skill.id === "sandbox-demo")
      assert.equal(demo.sourcePath, "sandbox-demo/SKILL.md")
      await api("POST", `/api/session/${sandboxSID}/skills`, { id: "sandbox-demo", content: "# Private override" })
      let listed = await api("GET", `/api/session/${sandboxSID}/skills`)
      assert.equal(
        listed.data.find((x) => x.skill.id === "sandbox-demo").source,
        "sandbox",
        "sandbox 必须遮蔽同名 session 快照",
      )
      await command(sandboxSID, `rm -f /workspace/.opencode/skills/sandbox-demo/SKILL.md`)
      listed = await api("POST", `/api/session/${sandboxSID}/skills/refresh`)
      assert.equal(
        listed.data.find((x) => x.skill.id === "sandbox-demo").source,
        "session",
        "删除 sandbox 文件后必须回落到 session 快照",
      )
      await api("DELETE", `/api/session/${sandboxSID}/skills/sandbox-demo`)
      listed = await api("GET", `/api/session/${sandboxSID}/skills`)
      assert(!listed.data.some((x) => x.skill.id === "sandbox-demo"), "删除 session 快照后不得残留该 ID")
      await command(
        sandboxSID,
        "printf -- '---\\nname: Sandbox Demo\\ndescription: Sandbox source\\n---\\n# Sandbox Demo\\n' > /workspace/.opencode/skills/sandbox-demo/SKILL.md",
      )
      listed = await api("POST", `/api/session/${sandboxSID}/skills/refresh`)
      assert.equal(
        listed.data.find((x) => x.skill.id === "sandbox-demo").source,
        "sandbox",
        "写回文件后 refresh 必须重新发现",
      )
      pass({ sid: sandboxSID, sandboxIds })
    }

    // T15.7 list 降级与 refresh 失败（独立坏域名容器 + 原容器恢复）
    begin("T15.7")
    {
      await api("POST", `/api/session/${sandboxSID}/skills`, { id: "degrade-session-item", content: "# degrade" })
      const badContainer = `${container}-baddomain`
      const badPort = port + 100
      const dockerURL2 = new URL(url)
      dockerURL2.hostname = "host.docker.internal"
      let badStarted = false
      await bootContainer(badContainer, badPort, {
        OPENCODE_DATABASE_URL: dockerURL2.toString(),
        OPENCODE_SANDBOX_DOMAIN: "10.255.255.1:9",
        OPENCODE_SANDBOX_USE_SERVER_PROXY: "true",
        OPENCODE_SANDBOX_VOLUME_TYPE: mode,
      })
      badStarted = true
      try {
        await waitInfo(badPort)
        const badBase = `http://127.0.0.1:${badPort}`
        const listResponse = await fetch(`${badBase}/api/session/${sandboxSID}/skills`, {
          headers,
          signal: AbortSignal.timeout(60000),
        })
        assert.equal(listResponse.status, 200, "list 必须 best-effort 成功")
        const listed = await listResponse.json()
        assert(
          listed.data.some((x) => x.skill.id === "degrade-session-item" && x.source === "session"),
          "降级时必须保留 Session 项",
        )
        const refreshResponse = await fetch(`${badBase}/api/session/${sandboxSID}/skills/refresh`, {
          method: "POST",
          headers,
          signal: AbortSignal.timeout(120000),
        })
        assert(refreshResponse.status >= 400, `refresh 必须显式失败: ${refreshResponse.status}`)
      } finally {
        if (badStarted) execFileSync("docker", ["rm", "-f", badContainer], { stdio: "ignore" })
      }
      const recovered = await api("POST", `/api/session/${sandboxSID}/skills/refresh`)
      assert(
        recovered.data.some((x) => x.skill.id === "sandbox-demo" && x.source === "sandbox"),
        "恢复后 refresh 重新发现",
      )
      pass({ refreshFailedStatus: ">=400", recovered: true })
    }

    // T15.8 显式 Skill attachment（真实模型）
    begin("T15.8")
    {
      const sid = await newSession("contract-t15-8", true)
      await waitUntil(
        async () => (await db`select state from sandbox where session_id=${sid}`)[0],
        (row) => row?.state === "running",
      )
      await api("POST", `/api/session/${sid}/skills`, { id: "reviewer", content: "# Reviewer\n只回复 REVIEWER_OK" })
      const run = await promptStream(sid, { text: "使用 reviewer", skills: [{ id: "reviewer" }], resume: true })
      assert.equal(run.status, 200, `prompt_stream非200: ${run.status} ${run.error ?? ""}`)
      assert(
        run.events.some((e) => e.type === "session.execution.succeeded"),
        "执行未成功",
      )
      assert(textOf(run.events).includes("REVIEWER_OK"), `输出缺少标记: ${textOf(run.events).slice(0, 300)}`)
      const missing = await promptStream(sid, {
        text: "使用 reviewer",
        skills: [{ id: "no-such-skill" }],
        resume: false,
      })
      assert.equal(missing.status, 400, `不存在attachment应400: ${missing.status}`)
      const mixed = await promptStream(sid, {
        text: "使用 reviewer",
        skills: [{ id: "reviewer" }, { id: "ghost" }],
        resume: false,
      })
      assert.equal(mixed.status, 400, `混合attachment应400: ${mixed.status}`)
      pass({ sid, elapsedMs: run.elapsedMs })
    }

    // T15.9 显式 Session Skill 激活
    // 激活 resume:true 本身驱动一轮执行；经SSE等待其输出，不再叠加prompt（避免busy竞争）。
    begin("T15.9")
    {
      const sid = await newSession("contract-t15-9", true)
      await waitUntil(
        async () => (await db`select state from sandbox where session_id=${sid}`)[0],
        (row) => row?.state === "running",
      )
      await api("POST", `/api/session/${sid}/skills`, { id: "activate-me", content: "# Activate\n回复 ACTIVATED" })
      const control = new AbortController()
      const stream = await fetch(`${base}/api/session/${sid}/event`, { headers, signal: control.signal })
      assert(stream.ok && stream.body)
      const reader = stream.body.getReader()
      const events = []
      let finished = false
      const pump = (async () => {
        let buffer = ""
        const decoder = new TextDecoder()
        try {
          while (!finished) {
            const chunk = await reader.read()
            if (chunk.done) break
            buffer += decoder.decode(chunk.value, { stream: true })
            let index
            while ((index = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, index).trim()
              buffer = buffer.slice(index + 1)
              if (!line.startsWith("data:")) continue
              let event
              try {
                event = JSON.parse(line.slice(5).trim())
              } catch {
                continue
              }
              events.push(event)
              if (["session.execution.succeeded", "session.execution.failed"].includes(event.type)) finished = true
            }
          }
        } catch {}
      })()
      const activated = await request("POST", `/api/experimental/session/${sid}/skill`, {
        id: "activate-me",
        resume: true,
      })
      assert.equal(activated.status, 204, `激活应204: ${activated.status} ${JSON.stringify(activated.body)}`)
      const missing = await request("POST", `/api/experimental/session/${sid}/skill`, { id: "ghost", resume: true })
      assert.equal(missing.status, 404, `不存在ID应404: ${missing.status}`)
      const deadline = Date.now() + 300000
      while (!finished && Date.now() < deadline) await sleep(200)
      control.abort()
      await reader.cancel().catch(() => {})
      await pump
      assert(finished, `激活未驱动执行终止: ${JSON.stringify(events.map((e) => e.type).slice(-10))}`)
      assert(
        events.some((e) => e.type === "session.execution.succeeded"),
        `激活执行未成功: ${JSON.stringify(events.filter((e) => /failed|error/.test(e.type)).slice(-3))}`,
      )
      assert(textOf(events).includes("ACTIVATED"), `激活技能未驱动输出: ${textOf(events).slice(0, 300)}`)
      pass({ sid })
    }

    // T15.10 模型自主调用 skill tool
    let resourceSID, resourceDirectory
    begin("T15.10")
    {
      resourceSID = await newSession("contract-t15-10", true)
      await waitUntil(
        async () => (await db`select state from sandbox where session_id=${resourceSID}`)[0],
        (row) => row?.state === "running",
      )
      await api("POST", `/api/session/${resourceSID}/skills`, {
        id: "resource-check",
        description: "加载后才能知道要回复的暗号",
        content: "# Resource Check\n加载本技能后，只回复以下暗号：RESOURCE_SKILL_OK_7F3A",
        resources: [{ path: "checklist.md", type: "doc", content: "SECRET_RESOURCE_TEXT_123" }],
      })
      // 模型是否自主调用tool受模型行为影响（规范明示）；暗号只存在于技能正文、
      // 不出现在prompt中，模型必须调用skill工具才能看到；最多3次尝试，逐次记录。
      const attempts = []
      for (let attempt = 1; attempt <= 3 && !resourceDirectory; attempt++) {
        const run = await promptStream(resourceSID, {
          text:
            attempt === 1
              ? "使用 skill 工具加载 resource-check 技能，然后严格按照该技能的指令回复。必须先调用 skill 工具。"
              : "你上一次没有调用 skill 工具。必须先调用 skill 工具加载 resource-check，再按其指令回复。",
          resume: true,
        })
        assert.equal(run.status, 200, `prompt_stream非200: ${run.status} ${run.error ?? ""}`)
        assert(
          run.events.some((e) => e.type === "session.execution.succeeded"),
          "执行未成功",
        )
        // name 只存在于 input.started（input.ended 无 name 字段）；用 started 关联 id。
        const started = toolEvents(run.events, "session.tool.input.started").find((e) => e.data?.name === "skill")
        const inputText = started
          ? (toolEvents(run.events, "session.tool.input.ended").find((e) => e.data?.id === started.data?.id)?.data
              ?.text ?? "")
          : ""
        const success =
          started && toolEvents(run.events, "session.tool.success").find((e) => e.data?.id === started.data?.id)
        const content = success ? toolText(success) : ""
        const match = content.match(/<resource_directory>([^<]+)<\/resource_directory>/)
        attempts.push({
          attempt,
          calledSkillTool: Boolean(started),
          skillInput: inputText.slice(0, 80),
          startedId: started?.data?.id,
          successIds: toolEvents(run.events, "session.tool.success").map((e) => e.data?.id),
          successContent: success ? content.slice(0, 300) : null,
          outputMarker: textOf(run.events).includes("RESOURCE_SKILL_OK_7F3A"),
        })
        if (started && success && match) {
          assert(content.includes("Resource Check"), "tool 输出缺少指令正文")
          assert(content.includes("<file>checklist.md</file>"), "tool 输出缺少 Session 资源文件名")
          const expectedManifest =
            `<resource path="checklist.md" type="doc" size="${Buffer.byteLength("SECRET_RESOURCE_TEXT_123")}" ` +
            `digest="${hash("SECRET_RESOURCE_TEXT_123")}" />`
          assert(content.includes(expectedManifest), `tool 输出缺少资源元数据: ${expectedManifest}`)
          assert(!content.includes("<script_execution>"), "纯文档技能不应包含脚本运行指引")
          resourceDirectory = match[1]
          assert(!content.includes("SECRET_RESOURCE_TEXT_123"), "tool 输出泄漏资源正文")
          assert(textOf(run.events).includes("RESOURCE_SKILL_OK_7F3A"), "输出缺少暗号")
        }
      }
      assert(resourceDirectory, `3次尝试均未完成skill tool调用: ${JSON.stringify(attempts)}`)
      pass({ sid: resourceSID, resourceDirectory, attempts })
    }

    // T15.11 资源物化、校验修复与 kill-sandbox 重建
    begin("T15.11")
    {
      assert(resourceDirectory, "依赖 T15.10")
      const digestPath = `/home/sandbox/.local/share/opencode/session-skills/${resourceSID}/resource-check/`
      assert(resourceDirectory.startsWith(digestPath), `目录前缀不符: ${resourceDirectory}`)
      const checklist = await command(resourceSID, `cat ${quote(`${resourceDirectory}/checklist.md`)}`)
      assert.equal(checklist, "SECRET_RESOURCE_TEXT_123")
      const marker = JSON.parse(await command(resourceSID, `cat ${quote(`${resourceDirectory}/resources.json`)}`))
      assert.equal(marker.version, 2)
      assert.equal(marker.id, "resource-check")
      assert(/^[a-f0-9]{64}$/.test(marker.contentDigest))
      assert(!JSON.stringify(marker).includes("SECRET_RESOURCE_TEXT_123"), "标记泄漏正文")
      const skillMd = await command(resourceSID, `cat ${quote(`${resourceDirectory}/SKILL.md`)}`)
      assert(skillMd.includes("Resource Check"))
      // 同尺寸损坏 → 下次加载修复
      await command(resourceSID, `printf 'SECRET_RESOURCE_TEXT_321' > ${quote(`${resourceDirectory}/checklist.md`)}`)
      const repair = await promptOnce(resourceSID, {
        text: "再次加载 resource-check",
        skills: [{ id: "resource-check" }],
        resume: false,
      })
      assert.equal(repair.status, 200)
      const repaired = await command(resourceSID, `cat ${quote(`${resourceDirectory}/checklist.md`)}`)
      assert.equal(repaired, "SECRET_RESOURCE_TEXT_123", "同尺寸损坏未修复")
      // 大型脚本两段执行（kill-sandbox 前后）
      const scriptProof = crypto.randomUUID()
      const artifact = `/workspace/skills-contract-${nonce}.json`
      const large = `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(artifact)}, JSON.stringify({ proof: ${JSON.stringify(scriptProof)} })); console.log('LARGE_SCRIPT_OK')`
      const largeContent = `// ${"x".repeat(120000 - large.length - 4)}\n${large}`
      assert.equal(Buffer.byteLength(largeContent), 120000)
      await api("POST", `/api/session/${resourceSID}/skills`, {
        id: "large-runner",
        content: "执行 scripts/large.mjs 并只回复其输出标记。",
        resources: [{ path: "scripts/large.mjs", type: "script", content: largeContent }],
      })
      const runLarge = async (label) => {
        const workspaceProbe = `/workspace/skills-contract-write-probe-${nonce}`
        const writable = await command(
          resourceSID,
          `if printf WORKSPACE_WRITABLE > ${quote(workspaceProbe)}; then cat ${quote(workspaceProbe)}; rm -f ${quote(workspaceProbe)}; else printf WORKSPACE_UNWRITABLE; fi`,
        )
        if (writable !== "WORKSPACE_WRITABLE") {
          const diagnostic = await command(
            resourceSID,
            [
              "id",
              "stat /workspace /home/sandbox /tmp/opencode 2>&1 || true",
              "readlink /workspace 2>&1 || true",
              "grep -E ' / |/workspace|/tmp/opencode' /proc/self/mountinfo 2>&1 || true",
              "df -T /workspace /home/sandbox 2>&1 || true",
            ].join("; "),
          )
          writeFileSync(
            path.join(out, "workspace-failure.json"),
            JSON.stringify({ sid: resourceSID, writable, diagnostic }, null, 2),
          )
        }
        assert.equal(writable, "WORKSPACE_WRITABLE", "脚本验收前 /workspace 必须能实际创建文件")
        await command(resourceSID, `rm -f ${quote(artifact)}`)
        let elapsedMs = 0
        let done = false
        for (let attempt = 1; attempt <= 3 && !done; attempt++) {
          const run = await promptStream(resourceSID, {
            text: `先调用 skill 工具加载 large-runner 技能。用 read 工具读取其 resource_directory 下 scripts/large.mjs 的第2行（offset:2, limit:1），再用 node 执行该脚本，只回复输出标记。必须实际读取并执行脚本。`,
            resume: true,
          })
          assert.equal(run.status, 200, `${label} prompt_stream非200: ${run.status} ${run.error ?? ""}`)
          assert(
            run.events.some((e) => e.type === "session.execution.succeeded"),
            `${label} 执行未成功`,
          )
          elapsedMs = run.elapsedMs
          const skillSuccess = toolCalls(run.events, "skill").find((call) => call.input?.id === "large-runner")?.success
          assert(skillSuccess && toolText(skillSuccess).includes("<script_execution>"), "脚本技能必须返回运行指引")
          assert(toolText(skillSuccess).includes("Loading a skill does not authorize shell execution"))
          const readCall = toolCalls(run.events, "read").find(
            (call) =>
              call.input?.path?.startsWith(
                `/home/sandbox/.local/share/opencode/session-skills/${resourceSID}/large-runner/`,
              ) && call.input.path.endsWith("/scripts/large.mjs"),
          )
          assert(
            readCall?.success && toolText(readCall.success).includes(scriptProof),
            "read 必须能读取 V1 目录下的脚本正文",
          )
          const shellSuccess = toolCalls(run.events, "shell").find((call) =>
            call.input?.command?.includes("scripts/large.mjs"),
          )?.success
          assert(shellSuccess && toolText(shellSuccess).includes("LARGE_SCRIPT_OK"), "必须有真实 shell 执行输出")
          // 产品会正确拒绝越权 owner 的读取（Path escapes the location）——那是安全防护，不计为隐藏失败。
          const hiddenFailures = toolEvents(run.events, "session.tool.failed").filter(
            (event) => !/Path escapes the location/.test(String(event.data?.error?.message ?? event.data?.error ?? "")),
          )
          assert.equal(hiddenFailures.length, 0, "脚本执行不得隐藏工具失败")
          const proof = JSON.parse(await command(resourceSID, `cat ${quote(artifact)}`))
          assert.equal(proof.proof, scriptProof, "脚本产物不匹配")
          done = textOf(run.events).includes("LARGE_SCRIPT_OK")
        }
        assert(done, `${label} 3次尝试均未得到 LARGE_SCRIPT_OK`)
        return elapsedMs
      }
      const firstMs = await runLarge("第一次")
      await api("POST", `/api/session/${resourceSID}/kill-sandbox`)
      // kill 后不自动重建；admission 触发重建与重新物化，再等待就绪。
      const remat = await promptOnce(resourceSID, {
        text: "再次加载 resource-check",
        skills: [{ id: "resource-check" }],
        resume: false,
      })
      assert.equal(remat.status, 200)
      await waitUntil(
        async () =>
          (await db`select state from sandbox where session_id=${resourceSID} order by time_updated desc limit 1`)[0],
        (row) => row?.state === "running",
        240000,
      )
      const recheck = await command(resourceSID, `cat ${quote(`${resourceDirectory}/checklist.md`)}`)
      assert.equal(recheck, "SECRET_RESOURCE_TEXT_123", "kill-sandbox 后未重新物化")
      const secondMs = await runLarge("第二次")
      pass({ resourceDirectory, firstMs, secondMs, artifact, scriptProof })
    }

    // T15.11r 物化失败拒绝 admission
    begin("T15.11r")
    {
      const sid = await newSession("contract-t15-11r", true)
      await waitUntil(
        async () => (await db`select state from sandbox where session_id=${sid}`)[0],
        (row) => row?.state === "running",
      )
      const created = await api("POST", `/api/session/${sid}/skills`, {
        id: "blocked",
        content: "运行 scripts/run.sh",
        resources: [{ path: "scripts/run.sh", type: "script", content: "echo OK" }],
      })
      const directory = `/home/sandbox/.local/share/opencode/session-skills/${sid}/${created.skill.id}/${hash(JSON.stringify({ content: created.skill.content, resources: created.resources.map(({ path, digest }) => ({ path, digest })).toSorted((a, b) => a.path.localeCompare(b.path)) }))}`
      await command(sid, `mkdir -p ${quote(`${directory}/scripts/run.sh`)}`)
      const before = (await db`select count(*)::int as n from session_inbox where session_id=${sid}`)[0].n
      const failed = await promptOnce(sid, { text: "加载 blocked", skills: [{ id: "blocked" }], resume: false })
      assert.equal(
        failed.status,
        400,
        `物化失败应拒绝admission: ${failed.status} ${JSON.stringify(failed.body).slice(0, 200)}`,
      )
      assert(
        JSON.stringify(failed.body).includes("materialize"),
        `错误类型不符: ${JSON.stringify(failed.body).slice(0, 300)}`,
      )
      assert.equal(
        (await db`select count(*)::int as n from session_inbox where session_id=${sid}`)[0].n,
        before,
        "失败不得写inbox",
      )
      await command(
        sid,
        `test ! -e ${quote(`${directory}/resources.json`)}; rmdir ${quote(`${directory}/scripts/run.sh`)}`,
      )
      const retried = await promptOnce(sid, { text: "加载 blocked", skills: [{ id: "blocked" }], resume: false })
      assert.equal(retried.status, 200)
      await command(sid, `test "$(cat ${quote(`${directory}/scripts/run.sh`)})" = 'echo OK'`)
      pass({ sid, directory })
    }

    // T15.12 guidance、权限与 tool 失败
    begin("T15.12")
    {
      const sid = await newSession("contract-t15-12", true)
      await waitUntil(
        async () => (await db`select state from sandbox where session_id=${sid}`)[0],
        (row) => row?.state === "running",
      )
      await api("POST", `/api/session/${sid}/skills`, {
        id: "manual-only",
        description: "手动加载后按指令回复",
        autoinvoke: false,
        content: "# Manual\n加载本技能后，只回复以下暗号：MANUAL_OK_9C2B",
      })
      const manual = await promptStream(sid, {
        text: "使用 skill 工具加载 manual-only 技能，然后严格按照该技能的指令回复。",
        resume: true,
      })
      assert.equal(manual.status, 200, `manual prompt非200: ${manual.status} ${manual.error ?? ""}`)
      assert(manual.events.some((e) => e.type === "session.execution.succeeded"))
      assert(textOf(manual.events).includes("MANUAL_OK_9C2B"), "autoinvoke:false 显式加载失败")
      const manualStarted = toolEvents(manual.events, "session.tool.input.started").find(
        (e) => e.data?.name === "skill",
      )
      const manualSuccess =
        manualStarted &&
        toolEvents(manual.events, "session.tool.success").find((e) => e.data?.id === manualStarted.data?.id)
      if (manualSuccess)
        assert(!JSON.stringify(manualSuccess.data).includes("/session/"), "无资源skill不得声明虚拟基目录")
      assert(Boolean(manualSuccess), "manual-only 必须经 skill 工具加载成功")
      // deny：独立会话
      const denySID = await newSession("contract-t15-12-deny", true, {
        permissions: [{ action: "skill", resource: "*", effect: "deny" }],
      })
      await waitUntil(
        async () => (await db`select state from sandbox where session_id=${denySID}`)[0],
        (row) => row?.state === "running",
      )
      await api("POST", `/api/session/${denySID}/skills`, { id: "blocked-load", content: "# Blocked" })
      // deny 语义是目录级：skill 工具从模型工具目录移除（catalog visibility），
      // 模型无法调用它。E2E 断言 = 多次诱导下 skill 工具始终不可达；
      // “目录内调用被 Permission.assert 拒绝”由 tool-skill 单测覆盖。
      let denyToolReached = false
      for (let attempt = 1; attempt <= 3; attempt++) {
        const denied = await promptStream(denySID, {
          text: "调用 skill 工具加载 blocked-load。必须调用工具。",
          resume: true,
        })
        assert.equal(denied.status, 200, `deny prompt非200: ${denied.status} ${denied.error ?? ""}`)
        denyToolReached =
          denyToolReached ||
          toolEvents(denied.events, "session.tool.input.started").some((e) => e.data?.name === "skill")
      }
      assert(!denyToolReached, "deny 会话中 skill 工具必须从模型目录移除、不可被调用")
      // 未知 ID：tool 报无法加载（同样有界重试）
      let unknownFailed
      for (let attempt = 1; attempt <= 3 && !unknownFailed; attempt++) {
        const unknown = await promptStream(sid, {
          text: "调用 skill 工具加载 no-such-skill-xyz。必须调用工具。",
          resume: true,
        })
        assert.equal(unknown.status, 200, `unknown prompt非200: ${unknown.status} ${unknown.error ?? ""}`)
        unknownFailed = toolEvents(unknown.events, "session.tool.failed").find((e) =>
          JSON.stringify(e.data).includes("no-such-skill-xyz"),
        )
      }
      assert(unknownFailed, "未知ID 3次尝试均未报加载失败")
      pass({ sid, denySID })
    }

    // T15.13 Sandbox 技能的附属文件必须在模型可见的 skill_files 中列出
    begin("T15.13")
    {
      const sid = resourceSID
      assert(sid, "依赖 T15.10 的 Session")
      const directory = "/workspace/.opencode/skills/sandbox-files"
      const skillText = [
        "---",
        "name: Sandbox Files",
        "description: Verify sandbox skill file discovery",
        "---",
        "加载本技能后回复 SANDBOX_FILES_OK。",
      ].join("\n")
      await command(
        sid,
        `mkdir -p ${quote(`${directory}/references`)} ${quote(`${directory}/scripts`)}; printf %s ${quote(Buffer.from(skillText).toString("base64"))} | base64 -d > ${quote(`${directory}/SKILL.md`)}; printf GUIDE_SECRET > ${quote(`${directory}/references/guide.md`)}; printf SCRIPT_SECRET > ${quote(`${directory}/scripts/probe.mjs`)}`,
      )
      let loaded
      for (let attempt = 1; attempt <= 3 && !loaded; attempt++) {
        const run = await promptStream(sid, {
          text: "必须先调用 skill 工具加载 sandbox-files 技能，再严格按技能指令回复。",
          resume: true,
        })
        assert.equal(run.status, 200, `sandbox skill prompt非200: ${run.status} ${run.error ?? ""}`)
        assert(run.events.some((event) => event.type === "session.execution.succeeded"), "sandbox skill 执行未成功")
        const call = toolCalls(run.events, "skill").find((item) => item.input?.id === "sandbox-files" && item.success)
        if (call) loaded = toolText(call.success)
      }
      assert(loaded, "3次提示均未成功加载 sandbox-files")
      assert(loaded.includes("<file>references/guide.md</file>"), "未列出 reference 文件")
      assert(loaded.includes("<file>scripts/probe.mjs</file>"), "未列出脚本文件")
      assert(!loaded.includes("<file>SKILL.md</file>"), "技能定义本身不应列为附属文件")
      assert(!loaded.includes("GUIDE_SECRET") && !loaded.includes("SCRIPT_SECRET"), "文件清单泄漏了附属文件正文")
      pass({ sid, files: ["references/guide.md", "scripts/probe.mjs"] })
    }
  }
  for (const [file, expected] of Object.entries(report.sourceSha256))
    assert.equal(
      hash(readFileSync(path.join(root, "packages/core/src", file), "utf8")),
      expected,
      "验收期间源码不得改变",
    )
  report.passed = report.cases.every((c) => c.passed)
} catch (error) {
  fail(error)
  report.passed = false
} finally {
  // 清理：DELETE 各会话（失败会话也尽力清理），移除容器。
  report.cleanupErrors = []
  for (const sid of report.sessions) {
    try {
      await deleteSession(sid, 120000)
    } catch (error) {
      report.cleanupErrors.push({ sid, error: String(error) })
    }
  }
  const badContainer = `${container}-baddomain`
  try {
    const logs = spawnSync("docker", ["logs", container], { encoding: "utf8", maxBuffer: 8000000 })
    if (logs.stdout !== null) writeFileSync(path.join(out, "saas.log"), (logs.stdout ?? "") + (logs.stderr ?? ""))
  } catch {}
  for (const name of [container, badContainer]) {
    try {
      execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" })
    } catch {}
  }
  try {
    const proof = {
      sessions: (await db`select count(*)::int as n from session_v2`)[0].n,
      inbox: (await db`select count(*)::int as n from session_inbox`)[0].n,
      skills: (await db`select count(*)::int as n from session_skills`)[0].n,
      sources: await db`select state, count(*)::int as n from sandbox group by state`,
    }
    writeFileSync(path.join(out, "pg-postcheck.json"), JSON.stringify(proof, null, 2))
    report.pgPostcheck = proof
    if (
      proof.sessions !== 0 ||
      proof.inbox !== 0 ||
      proof.skills !== 0 ||
      proof.sources.some((row) => row.state !== "destroyed")
    )
      report.cleanupErrors.push({ error: "PG 清理后仍有测试会话、技能、inbox 或未销毁沙箱" })
  } catch (error) {
    report.cleanupErrors.push({ error: String(error) })
  }
  if (report.cleanupErrors.length > 0) report.passed = false
  report.finishedAt = new Date().toISOString()
  save()
  proxy.stop(true)
  await db.close()
  // 专用库用完即删：此前每轮遗留一个 opencode-v2-skills-contract-* 数据库。
  const dropURL = new URL(url)
  dropURL.pathname = "/postgres"
  const drop = new Bun.SQL(dropURL.toString())
  try {
    await drop.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`)
  } catch (error) {
    report.cleanupErrors.push({ error: `DROP DATABASE failed: ${String(error)}` })
    report.passed = false
    save()
  } finally {
    await drop.close()
  }
  console.log(JSON.stringify({ passed: report.passed, cases: report.cases.length, evidence: out }))
}
