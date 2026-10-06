// 专用Docker/PG接口验收。resume:false只测试输入准备与资源物化，不调用真实模型。
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../../..")
const mode = process.env.PROBE_PERSIST_MODE ?? "pvc"
assert(["pvc", "snapshot"].includes(mode))
const nonce = crypto.randomUUID().slice(0, 8)
const cleanupRecord = process.env.PROBE_CLEANUP_EVIDENCE
  ? JSON.parse(readFileSync(process.env.PROBE_CLEANUP_EVIDENCE, "utf8"))
  : null
const databaseName = cleanupRecord?.databaseName ?? `opencode-v2-skills-test-${Date.now()}-${nonce}`
assert(/^opencode-v2-skills-(test|contract)-\d+-[a-f0-9]+$/.test(databaseName), "只允许技能探针专用数据库")
const runID = `session-skills-${mode}-${Date.now()}-${nonce}`
const container = `opencode-${runID}`
const port = Number(process.env.PROBE_PORT ?? 14101)
const out = path.join(root, "docs/test-cases/sandbox/store/evidence", runID)
mkdirSync(out, { recursive: true })
const report = {
  runID,
  databaseName,
  mode,
  passed: false,
  checks: [],
  sessions: [],
  sourceSha256: {},
  platformRequests: [],
}
const save = () => writeFileSync(path.join(out, "result.json"), JSON.stringify(report, null, 2))
const check = (ok, name, evidence = {}) => {
  assert(ok, name)
  report.checks.push({ name, ...evidence })
  save()
  console.log(JSON.stringify({ check: name }))
}
const config = JSON.parse(
  execFileSync("docker", ["inspect", process.env.PROBE_SOURCE_CONTAINER ?? "opencode-saas-test"], { encoding: "utf8" }),
)[0]
const env = Object.fromEntries(
  config.Config.Env.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
)
const upstream =
  process.env.PROBE_UPSTREAM ??
  `${env.OPENCODE_SANDBOX_PROTOCOL ?? "http"}://${env.OPENCODE_SANDBOX_DOMAIN.replace("host.docker.internal", "127.0.0.1")}`
// 平台可达性前置检查：建库前先拨测，环境故障立即终止（同 session-skills-contract-v2.mjs）。
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
assert(/test/.test(url.pathname), "只允许专用测试PG")
url.pathname = `/${databaseName}`
const db = new Bun.SQL(url.toString())
const base = `http://127.0.0.1:${port}`
const headers = {
  "Content-Type": "application/json",
  Authorization:
    "Basic " +
    Buffer.from(`${env.OPENCODE_SERVER_USERNAME ?? "opencode"}:${env.OPENCODE_SERVER_PASSWORD ?? ""}`).toString(
      "base64",
    ),
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
      timeoutSeconds: 60,
    })
    await waitUntil(
      async () => {
        if (error) throw error
        return ended
      },
      Boolean,
      90000,
    )
    assert.equal(ended.event.data.shell.exit, 0)
    return ended.text.replace(marker, "").trim()
  } finally {
    control.abort()
    await reader.cancel().catch(() => {})
    await pump
  }
}
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`
const hash = (s) => createHash("sha256").update(s).digest("hex")
let started = false
const proxy = Bun.serve({
  hostname: "0.0.0.0",
  port: 0,
  idleTimeout: 255,
  async fetch(request, server) {
    try {
      const requestURL = new URL(request.url)
      const route = requestURL.pathname.replace(/^\/v1(?=\/)/, "")
      const forwarded = new Headers(request.headers)
      forwarded.delete("host")
      // Runner uses WebSocket. HTTP-only forwarding makes valid executions
      // disconnect and falsely attributes test-proxy failures to CodeMode.
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
      if (
        requestURL.pathname.includes("/proxy/") &&
        requestURL.pathname.endsWith("/session") &&
        request.method === "POST"
      ) {
        const envelope = await response
          .clone()
          .json()
          .catch(() => null)
        report.platformRequests.push({
          path: requestURL.pathname,
          status: response.status,
          diagnostic: "command-session-envelope",
          keys: envelope && typeof envelope === "object" ? Object.keys(envelope) : [],
        })
        save()
      }
      if (!requestURL.pathname.includes("/proxy/")) {
        report.platformRequests.push({
          method: request.method,
          path: requestURL.pathname,
          status: response.status,
          ...(!response.ok ? { error: (await response.clone().text()).slice(0, 1000) } : {}),
        })
        save()
      }
      if (/\/endpoints\/\d+$/.test(route) && response.ok) {
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
      remote.addEventListener("error", () => {
        report.platformRequests.push({
          transport: "websocket",
          path: new URL(socket.data.wsURL).pathname,
          event: "error",
        })
        save()
        socket.close(1011, "upstream websocket failed")
      })
      remote.addEventListener("close", (event) => {
        report.platformRequests.push({
          transport: "websocket",
          path: new URL(socket.data.wsURL).pathname,
          event: "close",
          code: event.code,
          reason: event.reason,
        })
        save()
        socket.close()
      })
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
try {
  for (const file of [
    "session/skills.ts",
    "session/scan.ts",
    "session/prompt.ts",
    "session/context.ts",
    "tool/plugin/skill.ts",
    "codemode/runner.ts",
  ])
    report.sourceSha256[file] = hash(
      (await import("node:fs")).readFileSync(path.join(root, "packages/core/src", file), "utf8"),
    )
  const adminURL = new URL(url)
  adminURL.pathname = "/postgres"
  const admin = new Bun.SQL(adminURL.toString())
  try {
    if (!cleanupRecord) await admin.unsafe(`CREATE DATABASE "${databaseName}"`)
  } finally {
    await admin.close()
  }
  const dockerURL = new URL(url)
  dockerURL.hostname = "host.docker.internal"
  Object.assign(env, {
    OPENCODE_DATABASE_URL: dockerURL.toString(),
    OPENCODE_SANDBOX_DOMAIN: `host.docker.internal:${proxy.port}`,
    OPENCODE_SANDBOX_USE_SERVER_PROXY: "true",
    OPENCODE_SANDBOX_VOLUME_TYPE: mode,
    OPENCODE_SESSION_AUTO_KEEPALIVE: cleanupRecord ? "false" : "true",
    OPENCODE_SANDBOX_SNAPSHOT_ENABLED: "true",
    OPENCODE_SANDBOX_SNAPSHOT_WAIT_SEC: "120",
    OPENCODE_SANDBOX_SNAPSHOT_REFRESH_SEC: "1000000000",
    OPENCODE_SANDBOX_IDLE_REAP_SEC: "3600",
    OPENCODE_SANDBOX_TIMEOUT_SECONDS: "3600",
  })
  const args = ["run", "-d", "--name", container, "--no-healthcheck", "-p", `${port}:4096`]
  if (process.env.PROBE_MODEL_CONFIG)
    args.push("-v", `${process.env.PROBE_MODEL_CONFIG}:/home/opencode/.config/opencode/opencode.jsonc:ro`)
  for (const pkg of ["core", "server", "protocol"])
    args.push("-v", `${root}/packages/${pkg}/src:/app/packages/${pkg}/src:ro`)
  for (const [key, value] of Object.entries(env)) args.push("-e", `${key}=${value}`)
  args.push(config.Config.Image)
  execFileSync("docker", args, { encoding: "utf8" })
  started = true
  report.container = container
  report.image = config.Config.Image
  save()
  await waitUntil(
    async () => {
      try {
        const response = await request("GET", "/api/info", undefined, 5000)
        if (response.status !== 200) throw new Error(`SaaS就绪HTTP状态 ${response.status}`)
        return response.body
      } catch (error) {
        report.lastReadinessError = String(error)
        save()
        return null
      }
    },
    Boolean,
    60000,
  )
  if (cleanupRecord) {
    report.cleanupSource = process.env.PROBE_CLEANUP_EVIDENCE
    for (const sessionID of cleanupRecord.sessions) {
      const removed = await request("DELETE", `/api/session/${sessionID}`)
      assert([204, 404].includes(removed.status), `清理不能绕过生命周期保护: ${removed.status}`)
    }
    // Instantiate the provider without starting another sandbox. Its existing
    // stale-lease GC converges abandoned creating placeholders; no raw PG edit.
    const probe = await api("POST", "/api/session", {
      title: "stale-lease-gc-probe",
      location: { directory: "/workspace" },
    })
    report.sessions.push(probe.data.id)
    await api("GET", `/api/session/${probe.data.id}/skills`)
    await waitUntil(
      async () => (await db`select count(*)::int as n from sandbox where state='creating'`)[0].n,
      (n) => n === 0,
    )
    await api("DELETE", `/api/session/${probe.data.id}`)
    check(
      !report.platformRequests.some((request) => request.method === "POST" && request.path === "/v1/sandboxes"),
      "旧租约清理不新建远端沙箱",
    )
    check(
      (await db`select count(*)::int as n from sandbox where state <> 'destroyed'`)[0].n === 0,
      "旧创建租约通过现有GC收敛为destroyed",
    )
    const remaining = (await db`select count(*)::int as n from session_v2`)[0].n
    check(remaining === 0, "旧失败验收会话经DELETE接口清理，无PG session残留")
  } else {
    const created = await api("POST", "/api/session", {
      title: runID,
      sandbox: { cpu: "1", memory: "2Gi", image: env.OPENCODE_SANDBOX_IMAGE, persistMode: mode },
    })
    const sid = created.data.id
    report.sessions.push(sid)
    save()
    const source = await waitUntil(
      async () => {
        const row = (await db`select id,state from sandbox where session_id=${sid}`)[0]
        if (row?.state === "destroyed" && row.id.startsWith("creating-"))
          throw new Error("创建尝试失败，平台请求诊断已保留")
        return row
      },
      (row) => row?.state === "running",
    )
    report.sandboxID = source.id
    save()
    check(true, "独立SaaS/PG及真实沙箱就绪", { sandboxID: source.id })
    for (const resourcePath of ["SKILL.md", "resources.json", "SKILL.md/nested", "scripts/run.sh/child"]) {
      const resources =
        resourcePath === "scripts/run.sh/child"
          ? [
              { path: "scripts/run.sh", type: "script", content: "file" },
              { path: resourcePath, type: "doc", content: "conflict" },
            ]
          : [{ path: resourcePath, type: "doc", content: "overwrite" }]
      const bad = await request("POST", `/api/session/${sid}/skills`, { id: "invalid", content: "BODY", resources })
      check(bad.status === 400, "非法资源通过API拒绝且不落库", { resourcePath, status: bad.status })
    }
    check(
      (await db`select count(*)::int as n from session_skills where session_id=${sid}`)[0].n === 0,
      "非法资源未写入PG",
    )
    await command(
      sid,
      "mkdir -p /workspace/.opencode/skills/deploy/references; printf -- '---\ndescription: deploy\n---\nDEPLOY' > /workspace/.opencode/skills/deploy/SKILL.md; printf -- '---\ndescription: guide\n---\nREFERENCE' > /workspace/.opencode/skills/deploy/references/guide.md; printf -- '---\ndescription: flat\n---\nFLAT' > /workspace/.opencode/skills/flat.md",
    )
    const listed = await api("POST", `/api/session/${sid}/skills/refresh`)
    const ids = listed.data.filter((item) => item.source === "sandbox").map((item) => item.skill.id)
    check(
      ids.includes("deploy") && ids.includes("flat") && !ids.includes("guide"),
      "真实find对齐upstream布局，参考文档不是skill",
      { ids },
    )
    const info = await api("POST", `/api/session/${sid}/skills`, {
      id: "resource-test",
      content: "Run scripts/run.sh",
      resources: [{ path: "scripts/run.sh", type: "script", content: "echo RESOURCE_OK" }],
    })
    const directory = `/home/sandbox/.local/share/opencode/session-skills/${sid}/${info.skill.id}/${hash(JSON.stringify({ content: info.skill.content, resources: info.resources.map(({ path, digest }) => ({ path, digest })).toSorted((a, b) => a.path.localeCompare(b.path)) }))}`
    await command(sid, `mkdir -p ${quote(`${directory}/scripts/run.sh`)}`)
    const before = (await db`select count(*)::int as n from session_inbox where session_id=${sid}`)[0].n
    const failed = await request("POST", `/api/session/${sid}/prompt`, {
      text: "Load resource-test",
      skills: [{ id: "resource-test" }],
      resume: false,
    })
    check(failed.status === 400, "资源写入失败拒绝prompt admission", { status: failed.status })
    check(
      (await db`select count(*)::int as n from session_inbox where session_id=${sid}`)[0].n === before,
      "失败prompt未写入PG inbox",
    )
    await command(
      sid,
      `test ! -e ${quote(`${directory}/resources.json`)}; rmdir ${quote(`${directory}/scripts/run.sh`)}`,
    )
    check(true, "资源失败未发布完成标记")
    const admitted = await api("POST", `/api/session/${sid}/prompt`, {
      text: "Load resource-test",
      skills: [{ id: "resource-test" }],
      resume: false,
    })
    check(admitted.data.payload.skills[0].text.includes(directory), "重试成功且正文指向实际沙箱资源目录")
    await command(
      sid,
      `test "$(cat ${quote(`${directory}/scripts/run.sh`)})" = 'echo RESOURCE_OK'; node -e ${quote(`const fs=require("fs");const m=JSON.parse(fs.readFileSync(${JSON.stringify(`${directory}/resources.json`)},"utf8"));if(m.version!==2)process.exit(1)`)}`,
    )
    check(true, "完成标记版本与真实资源内容正确")
    await command(sid, `printf 'echo CORRUPT_BAD' > ${quote(`${directory}/scripts/run.sh`)}`)
    await api("POST", `/api/session/${sid}/prompt`, {
      text: "Load resource-test again",
      skills: [{ id: "resource-test" }],
      resume: false,
    })
    await command(sid, `test "$(cat ${quote(`${directory}/scripts/run.sh`)})" = 'echo RESOURCE_OK'`)
    check(true, "同尺寸损坏资源在下次加载时修复而不是信任marker")
    check(
      JSON.parse(
        (await db`select resources from session_skills where session_id=${sid} and skill_id='resource-test'`)[0]
          .resources,
      )[0].content === "echo RESOURCE_OK",
      "PG持久资源保持原始定义",
    )
    if (process.env.PROBE_RUNNER_READINESS === "true") {
      const { probeRunnerReadiness } = await import("./codemode-runner-readiness-v2.mjs")
      report.runnerReadiness = await probeRunnerReadiness({
        sandboxID: source.id,
        sessionID: sid,
        domain: `127.0.0.1:${proxy.port}`,
        apiKey: env.OPENCODE_SANDBOX_API_KEY,
        save: (result) => {
          report.runnerReadiness = result
          save()
        },
      })
      save()
    }
    if (process.env.PROBE_PERFORMANCE === "true") {
      const { measureSkillLoading } = await import("./session-skills-performance-v2.mjs")
      report.performance = await measureSkillLoading({
        sid,
        api,
        command,
        db,
        hash,
        quote,
        save: (result) => {
          report.performance = result
          save()
        },
      })
      save()
    }
    if (process.env.PROBE_MODEL_PERFORMANCE === "true") {
      const { measureSkillExecution } = await import("./session-skills-model-performance-v2.mjs")
      report.modelPerformance = await measureSkillExecution({
        api,
        command,
        db,
        base,
        headers,
        mode,
        image: env.OPENCODE_SANDBOX_IMAGE,
        save: (result) => {
          report.modelPerformance = result
          save()
        },
      })
      save()
    }
    await api("DELETE", `/api/session/${sid}`)
    const remaining = await db`select count(*)::int as n from session_v2`
    check(remaining[0].n === 0, "成功会话清理，PG无session残留")
  }
  for (const [file, expected] of Object.entries(report.sourceSha256))
    assert.equal(
      hash((await import("node:fs")).readFileSync(path.join(root, "packages/core/src", file), "utf8")),
      expected,
      "验收期间源码不得改变",
    )
  report.passed = !report.modelPerformance || report.modelPerformance.samples.every((sample) => sample.passed)
  if (!report.passed) process.exitCode = 1
} catch (error) {
  report.error = String(error)
  process.exitCode = 1
} finally {
  report.finishedAt = new Date().toISOString()
  save()
  if (started) {
    const logs = spawnSync("docker", ["logs", container], { encoding: "utf8", maxBuffer: 8000000 })
    writeFileSync(path.join(out, "saas.log"), (logs.stdout ?? "") + (logs.stderr ?? ""))
    execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" })
  }
  proxy.stop(true)
  await db.close()
  // 专用库用完即删：避免逐轮遗留 opencode-v2-skills-test-* 数据库。
  const dropURL = new URL(url)
  dropURL.pathname = "/postgres"
  const drop = new Bun.SQL(dropURL.toString())
  try {
    await drop.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`)
  } catch (error) {
    report.error = report.error ? `${report.error}; DROP DATABASE failed: ${String(error)}` : `DROP DATABASE failed: ${String(error)}`
    report.passed = false
    save()
  } finally {
    await drop.close()
  }
  console.log(
    JSON.stringify({ passed: report.passed, checks: report.checks.length, evidence: out, error: report.error }),
  )
}
