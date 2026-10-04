// 专用Docker SaaS + 专用PG + 本进程故障代理；不停止共享服务或源沙箱。
// 使用：OPENCODE_DATABASE_URL=postgresql://local@127.0.0.1:5432/opencode-v2-lifecycle-test-20261004 bun <本文件>
// E2E只覆盖API/shell/PG/平台，不冒充真实AI/code-mode。失败保留测试资源。
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../../..")
const mode = process.env.PROBE_PERSIST_MODE ?? "snapshot"
assert(["snapshot", "pvc"].includes(mode), "持久化模式必须为snapshot或pvc")
const nonce = crypto.randomUUID().slice(0, 8)
const runID = `lifecycle-${mode}-${Date.now()}-${nonce}`
const container = `opencode-${runID}`
const port = Number(process.env.PROBE_PORT ?? 14097)
const source = process.env.PROBE_SOURCE_CONTAINER ?? "opencode-saas-test"
const databaseURL = new URL(process.env.OPENCODE_DATABASE_URL ?? "")
assert(databaseURL.pathname.includes("lifecycle-test"), "必须使用专用lifecycle-test库，禁止共享开发库")
const databaseName = `opencode-v2-lifecycle-test-${mode}-${Date.now()}-${nonce}`
assert(/^[a-z0-9-]+$/.test(databaseName) && databaseName.length <= 63, "专用库名不合法")
databaseURL.pathname = `/${databaseName}`
const outDir = process.env.PROBE_EVIDENCE_DIR ?? path.join(root, "docs/test-cases/sandbox/store/evidence", runID)
mkdirSync(outDir, { recursive: true })
const report = { runID, databaseName, mode, startedAt: new Date().toISOString(), passed: false, checks: [], sessions: [], sandboxIDs: [], createdSandboxes: [], faultRequests: [], platformRequests: [], acceleratedRetries: [] }
const save = () => writeFileSync(path.join(outDir, "result.json"), JSON.stringify(report, null, 2))
const check = (condition, name, evidence = {}) => {
  assert(condition, name)
  report.checks.push({ name, ...evidence }); save()
  console.log(JSON.stringify({ check: name }))
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const config = JSON.parse(execFileSync("docker", ["inspect", source], { encoding: "utf8" }))[0]
const env = Object.fromEntries(config.Config.Env.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]))
const upstream = `${env.OPENCODE_SANDBOX_PROTOCOL ?? "http"}://${env.OPENCODE_SANDBOX_DOMAIN.replace("host.docker.internal", "127.0.0.1")}`
const platformHeaders = { "OPEN-SANDBOX-API-KEY": env.OPENCODE_SANDBOX_API_KEY ?? "" }
const headers = { "Content-Type": "application/json", Authorization: "Basic " + Buffer.from(`${env.OPENCODE_SERVER_USERNAME ?? "opencode"}:${env.OPENCODE_SERVER_PASSWORD ?? ""}`).toString("base64") }
const base = `http://127.0.0.1:${port}`
const db = new Bun.SQL(databaseURL.toString())
const { Sandbox, ConnectionConfig } = await import(Bun.resolveSync("@alibaba-group/opensandbox", path.join(root, "packages/core")))
let faultSandboxID = null
let started = false
const proxy = Bun.serve({
  hostname: "0.0.0.0", port: 0, idleTimeout: 255,
  async fetch(request) {
    try {
      const url = new URL(request.url)
      const route = url.pathname.replace(/^\/v1(?=\/)/, "")
      if (faultSandboxID && request.method === "POST" && route === `/sandboxes/${faultSandboxID}/snapshots`) {
        report.faultRequests.push({ method: request.method, path: url.pathname, at: Date.now() }); save()
        return Response.json({ code: "InjectedSnapshotFailure", message: "dedicated test: snapshot creation failed" }, { status: 500 })
      }
      if (faultSandboxID && request.method === "DELETE" && route === `/sandboxes/${faultSandboxID}`) {
        report.faultRequests.push({ unexpectedDelete: true, path: url.pathname, at: Date.now() }); save()
      }
      const forwardHeaders = new Headers(request.headers)
      forwardHeaders.delete("host")
      const body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer()
      const response = await fetch(upstream + url.pathname + url.search, {
        method: request.method, headers: forwardHeaders,
        body,
        signal: AbortSignal.timeout(180000),
      })
      if (request.method === "POST" && route === "/sandboxes" && response.ok) {
        const input = JSON.parse(new TextDecoder().decode(body))
        const output = await response.clone().json()
        report.createdSandboxes.push({ sessionID: input.metadata?.session, id: output.id }); save()
      }
      if (!url.pathname.includes("/proxy/")) {
        report.platformRequests.push({ method: request.method, path: url.pathname, status: response.status }); save()
      }
      if (/\/endpoints\/\d+$/.test(route) && response.ok) {
        const endpoint = await response.json()
        const address = new URL(`http://${endpoint.endpoint}`)
        assert(address.pathname.includes("/proxy/"), "测试代理要求平台server-proxy端点")
        endpoint.endpoint = `host.docker.internal:${proxy.port}${address.pathname}${address.search}`
        return Response.json(endpoint, { status: response.status })
      }
      return response
    } catch (cause) {
      report.platformRequests.push({ error: String(cause) }); save()
      return Response.json({ message: "dedicated test proxy unavailable" }, { status: 502 })
    }
  },
})
async function api(method, route, body) {
  const response = await fetch(base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(360000) })
  const text = await response.text()
  assert(response.ok, `${method} ${route}: ${response.status}: ${text.slice(0, 180)}`)
  return text ? JSON.parse(text) : null
}
async function waitUntil(read, predicate, timeout = 240000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await read()
    if (predicate(result)) return result
    await sleep(500)
  }
  throw new Error("等待验收条件超时")
}
async function row(sid) { return (await db`select id,state,keep_alive,command_session_id,time_updated from sandbox where session_id=${sid}`)[0] }
const kept = (row) => row.keep_alive === true || Number(row.keep_alive) === 1
async function command(sid, script) {
  const marker = `EXEC_${crypto.randomUUID()}`
  const control = new AbortController()
  const response = await fetch(base + `/api/session/${sid}/event`, { headers, signal: control.signal })
  assert(response.ok && response.body, "SSE不可用")
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
          const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1)
          if (!line.startsWith("data:")) continue
          let event
          try { event = JSON.parse(line.slice(5).trim()) } catch { continue }
          const output = event.data?.output
          const text = typeof output === "string" ? output : String(output?.output ?? "")
          if (event.type === "session.shell.ended" && text.includes(marker)) ended = { event, text }
        }
      }
    } catch (cause) { if (!control.signal.aborted) error = cause }
  })()
  try {
    await api("POST", `/api/session/${sid}/shell`, { command: `set -eu; ${script}; echo ${marker}`, timeoutSeconds: 60 })
    await waitUntil(async () => { if (error) throw error; return ended }, Boolean, 90000)
    assert.equal(ended.event.data.shell.exit, 0)
    return ended.text.replace(marker, "").trim()
  } finally {
    control.abort(); await reader.cancel().catch(() => {}); await pump
  }
}
async function create(parentID, title) {
  const result = await api("POST", "/api/session", parentID ? { parentID } : { title, sandbox: { cpu: "1", memory: "2Gi", image: env.OPENCODE_SANDBOX_IMAGE, persistMode: mode } })
  const sid = result?.data?.id
  assert.equal(typeof sid, "string")
  report.sessions.push(sid); save()
  return sid
}
async function inspect(id) {
  const response = await fetch(`${upstream}/sandboxes/${id}`, { headers: platformHeaders, signal: AbortSignal.timeout(15000) })
  assert(response.ok, `平台实例 ${id}: ${response.status}`)
  const result = await response.json()
  return { id: result.id, state: result.status?.state, snapshotId: result.snapshotId }
}

try {
  const adminURL = new URL(databaseURL)
  adminURL.pathname = "/postgres"
  const admin = new Bun.SQL(adminURL.toString())
  try { await admin.unsafe(`CREATE DATABASE "${databaseName}"`) } finally { await admin.close() }
  const dockerDB = new URL(databaseURL)
  dockerDB.hostname = "host.docker.internal"
  Object.assign(env, {
    OPENCODE_DATABASE_URL: dockerDB.toString(),
    OPENCODE_SANDBOX_DOMAIN: `host.docker.internal:${proxy.port}`,
    OPENCODE_SANDBOX_USE_SERVER_PROXY: "true",
    OPENCODE_SESSION_AUTO_KEEPALIVE: "true", OPENCODE_SANDBOX_VOLUME_TYPE: mode,
    OPENCODE_SANDBOX_SNAPSHOT_ENABLED: "true", OPENCODE_SANDBOX_SNAPSHOT_WAIT_SEC: "120",
    OPENCODE_SANDBOX_TIMEOUT_SECONDS: "3600",
    // 保持每60秒队列扫描，但年龄阈值远大于测试时长，不触发周期内容保存。
    OPENCODE_SANDBOX_SNAPSHOT_REFRESH_SEC: "1000000000", OPENCODE_SANDBOX_IDLE_REAP_SEC: "3600",
  })
  const args = ["run", "-d", "--name", container, "--no-healthcheck", "-p", `${port}:4096`,
    "-v", `${root}/packages/core/src:/app/packages/core/src:ro`, "-v", `${root}/packages/server/src:/app/packages/server/src:ro`,
    "-v", `${root}/packages/protocol/src:/app/packages/protocol/src:ro`]
  for (const [key, value] of Object.entries(env)) args.push("-e", `${key}=${value}`)
  args.push(config.Config.Image)
  execFileSync("docker", args, { encoding: "utf8" }); started = true
  report.container = container; report.image = config.Config.Image; save()
  await waitUntil(async () => { try { return await api("GET", "/api/info") } catch { return null } }, Boolean, 60000)
  const sid = await create()
  const initial = await waitUntil(() => row(sid), (r) => r?.state === "running")
  report.sandboxIDs.push(initial.id); save()
  check(kept(initial), "root创建即自动保活与boot", { initial })
  const mounted = await command(sid, `node -e 'const fs=require("node:fs");const mounted=fs.readFileSync("/proc/self/mountinfo","utf8").split("\\n").some(l=>l.split(" ")[4]==="/workspace");if(mounted!==${mode === "pvc"})process.exit(1)'`)
  check(true, "workspace挂载与持久化模式互斥", { mode, mounted })
  await command(sid, "printf 'v1\\n' > /workspace/work.txt")
  let snapshotID
  if (mode === "snapshot") {
    const snap = await api("POST", `/api/session/${sid}/snapshot`)
    snapshotID = snap?.data?.snapshotID
    assert.equal(typeof snapshotID, "string")
    await waitUntil(async () => (await db`select state from session_snapshot where id=${snapshotID}`)[0], (r) => r?.state === "ready")
    check(true, "基线快照Ready", { snapshotID })
  }

  const released = await api("POST", `/api/experimental/session/${sid}/keep-alive`, { enabled: false })
  const afterRelease = await row(sid)
  check(released.keepAlive === false && !kept(afterRelease) && afterRelease.id === initial.id && afterRelease.state === "running", "取消保活不销毁或切换代际")
  check((await inspect(initial.id)).state === "Running", "取消保活后平台源仍运行")
  await command(sid, "grep -q v1 /workspace/work.txt")

  const child = await create(sid)
  const opCount = Number((await db`select count(*)::int as n from snapshot_operation where session_id=${sid}`)[0].n)
  await command(child, "printf 'child\\n' > /workspace/child.txt")
  await sleep(2000)
  const parentAfterChild = await row(sid)
  check(parentAfterChild.id === initial.id && parentAfterChild.state === "running" && !kept(parentAfterChild), "非保活root下子会话执行结束不销毁共享沙箱")
  check(!(await row(child)), "子会话没有独立物理sandbox行")
  const opsAfterChild = Number((await db`select count(*)::int as n from snapshot_operation where session_id=${sid}`)[0].n)
  check(opsAfterChild === opCount, "子会话结束未生成root保存或销毁操作")
  await api("POST", `/api/experimental/session/${sid}/keep-alive`, { enabled: true })

  // 仅推进本用例PG行：让仍健康的旧缓存失去running身份，验证不能继续复用。
  await db`update sandbox set state='destroyed', command_session_id=null where session_id=${sid} and id=${initial.id}`
  const noPreview = await fetch(base + `/api/session/${sid}/endpoint/5173`, { headers })
  check(noPreview.status === 502, "preview不复用PG已失效但仍健康的缓存")
  await noPreview.body?.cancel()
  const boot = await api("POST", `/api/experimental/session/${sid}/keep-alive`, { enabled: true, boot: true })
  const current = await row(sid)
  check(typeof boot.sandboxId === "string" && current.state === "running" && current.id === boot.sandboxId && current.id !== initial.id, "boot丢弃旧缓存并解析新代际")
  report.sandboxIDs.push(current.id); save()
  if (mode === "snapshot") check((await inspect(current.id)).snapshotId === snapshotID, "新代际恢复自基线快照")
  else check(!(await inspect(current.id)).snapshotId, "PVC重建未使用快照恢复")
  await command(sid, "grep -q v1 /workspace/work.txt; printf 'v2\\n' > /workspace/work.txt")

  if (mode === "snapshot") {
  faultSandboxID = current.id
  let killError
  const killing = api("POST", `/api/session/${sid}/kill-sandbox`).catch((cause) => { killError = String(cause); return null })
  const deadline = Date.now() + 400000
  const accelerated = new Set()
  let terminal
  while (Date.now() < deadline) {
    const operations = await db`select id,state,attempts,error from snapshot_operation where session_id=${sid} and kind='snapshot_destroy' order by time_created desc limit 1`
    const operation = operations[0]
    if (operation?.state === "failed") { terminal = operation; break }
    if (operation?.state === "pending" && !accelerated.has(operation.attempts)) {
      // 只缩短本测试操作的退避，不改变attempts或伪造终态；每次领取/失败仍由真实worker完成。
      await db`update snapshot_operation set next_retry_at=${Date.now() - 1} where id=${operation.id} and state='pending'`
      report.acceleratedRetries.push({ id: operation.id, attempts: operation.attempts }); save()
      accelerated.add(operation.attempts)
    }
    await sleep(1000)
  }
  check(terminal?.state === "failed" && Number(terminal.attempts) === 5, "真实destroy队列耗尽5次重试而不是降级销毁", { terminal })
  const retained = await row(sid)
  check(retained.id === current.id && retained.state !== "destroyed", "最终快照创建失败保留同一源代际", { retained })
  check((await inspect(current.id)).state === "Running", "重试耗尽后远端源仍Running")
  check(report.faultRequests.filter((x) => !x.unexpectedDelete).length >= 5 && !report.faultRequests.some((x) => x.unexpectedDelete), "5次失败均未发出源DELETE")
  const sdk = await Sandbox.connect({ connectionConfig: new ConnectionConfig({ domain: env.OPENCODE_SANDBOX_DOMAIN.replace(`host.docker.internal:${proxy.port}`, new URL(upstream).host), protocol: env.OPENCODE_SANDBOX_PROTOCOL ?? "http", apiKey: env.OPENCODE_SANDBOX_API_KEY, useServerProxy: true }), sandboxId: current.id })
  try {
    const verified = await sdk.commands.run("grep -qx v2 /workspace/work.txt", { timeoutSeconds: 15 })
    check(verified.exitCode === 0, "保留源中最新v2内容完整")
  } finally { await sdk.close() }
  check((await db`select state from session_snapshot where id=${snapshotID}`)[0]?.state === "stale", "旧恢复点仍保留而非冒充v2")

  // 故障解除前结束专用worker等待；记录HTTP结果，不以destroyed字段替代平台状态。
  const killResult = await killing
  report.killResult = killResult; report.killError = killError
  check(killResult?.destroyed === false, "快照失败kill明确返回未销毁")
  check((await row(sid)).state === "running", "快照失败源恢复running无需人工复位")
  await command(sid, "grep -qx v2 /workspace/work.txt; printf 'v3\\n' > /workspace/work.txt")
  check(true, "失败后通过SaaS继续执行并保留最新修改")
  const refused = await fetch(base + `/api/session/${sid}`, { method: "DELETE", headers, signal: AbortSignal.timeout(360000) })
  report.deleteRetainedStatus = refused.status; save()
  check(refused.status === 409, "失败源DELETE拒绝继续删除会话", { status: refused.status })
  await refused.body?.cancel()
  check((await db`select id from session_v2 where id=${sid}`).length === 1 && (await db`select id from session_snapshot where id=${snapshotID}`).length === 1, "DELETE受阻后会话和恢复点仍在PG")
  await command(sid, "grep -qx v3 /workspace/work.txt")
  check(true, "DELETE受阻后逻辑admission重新开放")
  faultSandboxID = null
  }
  await api("POST", `/api/session/${sid}/kill-sandbox`)
  check((await row(sid)).state === "destroyed", mode === "snapshot" ? "故障解除后创建成功才安全销毁" : "PVC显式销毁仍由独立接口执行")
  const old = await Sandbox.connect({ connectionConfig: new ConnectionConfig({ domain: new URL(upstream).host, protocol: env.OPENCODE_SANDBOX_PROTOCOL ?? "http", apiKey: env.OPENCODE_SANDBOX_API_KEY, useServerProxy: true }), sandboxId: initial.id })
  try { await old.kill() } finally { await old.close() }
  await api("DELETE", `/api/session/${sid}`)

  // 专用库中仅对这个唯一title的首次running落库注入确定失败；保留真实创建租约流程。
  const faultTitle = `persist-fault-${nonce}`
  await db.unsafe(`CREATE FUNCTION lifecycle_fail_persist() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.state='running' AND OLD.state='creating' AND EXISTS
        (SELECT 1 FROM session_v2 WHERE id=NEW.session_id AND title='${faultTitle}') THEN
        RAISE EXCEPTION 'dedicated lifecycle test: sandbox persistence failed';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER lifecycle_fail_persist BEFORE UPDATE ON sandbox FOR EACH ROW EXECUTE FUNCTION lifecycle_fail_persist();`)
  let compensationSID
  try {
    compensationSID = await create(undefined, faultTitle)
    const completed = await waitUntil(async () => ({
      row: await row(compensationSID),
      created: report.createdSandboxes.find((x) => x.sessionID === compensationSID),
    }), (r) => r.row?.state === "destroyed" && r.row.id.startsWith("creating-") && r.created?.id &&
      report.platformRequests.some((x) => x.method === "DELETE" && x.path.endsWith(`/sandboxes/${r.created.id}`) && x.status === 204), 300000)
    const compensated = completed.row
    const created = completed.created
    check(Boolean(created?.id), "落库失败注入发生在真实远端创建成功之后")
    check(report.platformRequests.some((x) => x.method === "DELETE" && x.path.endsWith(`/sandboxes/${created.id}`) && x.status === 204), "PG确定落库失败后补偿删除未归属远端实例")
    check(compensated.id.startsWith("creating-") && compensated.state === "destroyed", "异常补偿释放原创建租约", { compensated })
    const removed = await fetch(`${upstream}/sandboxes/${created.id}`, { headers: platformHeaders })
    check(removed.status === 404, "平台确认未落库实例已回收")
    await removed.body?.cancel()
  } finally {
    await db.unsafe("DROP TRIGGER lifecycle_fail_persist ON sandbox; DROP FUNCTION lifecycle_fail_persist();")
  }
  await api("DELETE", `/api/session/${compensationSID}`)
  report.passed = true
} catch (cause) {
  report.error = String(cause); process.exitCode = 1
} finally {
  report.finishedAt = new Date().toISOString(); save()
  if (started) {
    const logs = spawnSync("docker", ["logs", container], { encoding: "utf8", maxBuffer: 8000000 })
    writeFileSync(path.join(outDir, "saas.log"), (logs.stdout ?? "") + (logs.stderr ?? ""))
    // 只移除本脚本创建的SaaS容器；失败时远端沙箱/PG记录不清理。
    execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" })
  }
  proxy.stop(true); await db.close()
  console.log(JSON.stringify({ passed: report.passed, error: report.error, checks: report.checks.length, evidence: outDir, retainedSessions: report.passed ? [] : report.sessions }))
}
