// 真实 Vercel 双 Pod 验收：端口合并、旧扫描与活动刷新/云端 generation 替换竞争。
// 由 sandbox-vercel-t19.mjs 包装，负责公共 SSE、自动答表单和最终清理。
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, writeFile } from "node:fs/promises"

const base = process.env.BASE
const second = process.env.BASE_SECONDARY
const container = process.env.VERCEL_TEST_CONTAINER
assert.ok(second && container?.startsWith("opencode-vercel-t19-"))
assert.ok(process.env.PG_URL?.endsWith("-vercel-audit-e2e-test"))
const out = process.env.STRESS_OUT
await mkdir(out, { recursive: true })
const report = { passed: false, checks: [], codeMode: "本脚本为生命周期/网关 API 测试；模型轮次另见 F 阶段" }
const headers = { authorization: `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString("base64")}`, "content-type": "application/json" }
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const pg = (query) => execFileSync("psql", [process.env.PG_URL, "-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1", "-c", query], { encoding: "utf8" }).trim()
const api = async (path, method = "GET", body, target = base) => {
  const response = await fetch(target + path, { headers, method, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(180000) })
  assert.ok(response.ok, `${method} ${path}: HTTP ${response.status}`)
  return response.status === 204 ? null : response.json()
}
const row = (id) => JSON.parse(pg(`SELECT json_build_object('id',id,'state',state,'updated',time_updated,'name',remote_name)::text FROM sandbox WHERE session_id='${id}'`))
const native = (name, action) => {
  const code = `const {Sandbox}=await import("@vercel/sandbox");const connection={teamId:process.env.VERCEL_TEAM_ID,projectId:process.env.VERCEL_PROJECT_ID,token:process.env.VERCEL_TOKEN,name:${JSON.stringify(name)}};const sandbox=await Sandbox.get({...connection,resume:false});${action}`
  return JSON.parse(execFileSync("docker", ["exec", "-w", "/app/packages/core", container, "bun", "-e", code], { encoding: "utf8", timeout:120000, stdio:["ignore","pipe","pipe"] }).trim())
}
const check = (name, detail) => { report.checks.push({ name, passed: true, ...detail }); console.log(`✓ ${name}`) }
async function shell(id, command, expected, target = base) {
  await api(`/api/session/${id}/shell`, "POST", { command }, target)
  const message = (await api(`/api/session/${id}/message?order=asc&limit=100`)).data.filter((message) => message.type === "shell" && message.command === command).at(-1)
  assert.equal(message?.exit, 0, JSON.stringify(message))
  if (expected) assert.ok(message.output.output.includes(expected), JSON.stringify(message.output))
}

// Hold the sandbox row while both sweepers read the old committed activity.
// Before releasing it, change activity or advance the actual cloud generation.
async function staleScan(id, replace) {
  const before = row(id)
  const lock = spawn("psql", [process.env.PG_URL, "-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1"], { stdio: ["pipe", "pipe", "pipe"] })
  const closed = once(lock, "close")
  let output = "", errors = ""
  lock.stdout.on("data", (chunk) => { output += chunk })
  lock.stderr.on("data", (chunk) => { errors += chunk })
  let released = false
  try {
    // Same connection, adjacent autocommit+BEGIN statements minimize the setup window.
    lock.stdin.write(`UPDATE sandbox SET time_updated=0 WHERE session_id='${id}'; BEGIN; SELECT id FROM sandbox WHERE session_id='${id}' FOR UPDATE; SELECT 'AUDIT_LOCKED';\n`)
    const deadline = Date.now() + 60000
    while (!output.includes("AUDIT_LOCKED")) {
      assert.ok(Date.now() < deadline && lock.exitCode === null, `未取得锁 ${errors}`)
      await delay(100)
    }
    assert.equal(row(id).state, "running", "竞争设置前实例已被回收")
    let blocked = 0
    while (blocked < 2) {
      blocked = Number(pg("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ~* 'update.*sandbox'"))
      assert.ok(Date.now() < deadline, `未观察到两个 Pod 的回收 CAS 被锁阻塞：${blocked}`)
      await delay(250)
    }
    let generation = before.id
    if (replace) {
      const value = native(before.name, 'const stopped=await sandbox.stop();if(stopped.snapshot?.status!=="created")throw new Error("快照未保存");const resumed=await Sandbox.get({...connection,resume:true});console.log(JSON.stringify({generation:resumed.currentSession().sessionId}));')
      generation = value.generation
      assert.ok(generation && generation !== before.id)
    }
    lock.stdin.end(`UPDATE sandbox SET id='${generation}',time_updated=GREATEST(time_updated+1,${Date.now()}) WHERE session_id='${id}'; COMMIT;\n`)
    released = true
    const [code] = await closed
    assert.equal(code, 0, errors)
    // Both blocked claims must finish without stopping the active cloud generation.
    const settled = Date.now() + 15000
    while (Number(pg("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ~* 'update.*sandbox'")) > 0) {
      assert.ok(Date.now() < settled, "回收 CAS 未释放")
      await delay(100)
    }
    await delay(2000)
    const after = row(id)
    assert.equal(after.state, "running")
    assert.equal(after.id, generation)
    const cloud = native(before.name, 'console.log(JSON.stringify({generation:sandbox.currentSession().sessionId,status:sandbox.currentSession().status}));')
    assert.equal(cloud.generation, generation)
    assert.equal(cloud.status, "running")
    check(replace ? "旧扫描不能停止真实 stop/resume 后的新代次" : "两个 Pod 的旧扫描不能停止活动水位已刷新的实例", { blocked, before: before.id, after: after.id })
  } finally {
    if (!released && !lock.stdin.destroyed) lock.stdin.end("ROLLBACK;\n")
    if (!released) await closed
  }
}

let id
try {
  id = (await api("/api/session", "POST", { title: "vercel-audit-concurrent-race", sandbox: { persistMode: "snapshot", cpu: "2", memory: "4Gi" } })).data.id
  await writeFile(`${out}/session.json`, JSON.stringify({ id }))
  await shell(id, "printf 'vercel-audit-marker' > /workspace/audit-marker.txt; cat /workspace/audit-marker.txt", "vercel-audit-marker")
  const server = `const http=require("http");for(const p of [8081,8082])http.createServer((q,s)=>s.end("port-"+p)).listen(p,"127.0.0.1");`
  await shell(id, `printf %s '${Buffer.from(server).toString("base64")}' | base64 -d > /workspace/audit-http.cjs; (nohup node /workspace/audit-http.cjs >/tmp/audit-http.log 2>&1 </dev/null &); sleep 1`)
  const endpoints = await Promise.all([api(`/api/session/${id}/endpoint/8081`), api(`/api/session/${id}/endpoint/8082`, "GET", undefined, second)])
  for (let index = 0; index < endpoints.length; index++) {
    const url = endpoints[index].directUrl
    assert.ok(url?.includes("/t/"), "端口必须经过 token gate")
    const deadline = Date.now() + 30000
    for (;;) {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) }).catch(() => null)
      if (response?.ok) { assert.equal(await response.text(), `port-${8081 + index}`); break }
      assert.ok(Date.now() < deadline, "并发注册后的端口不可达")
      await delay(500)
    }
  }
  // Fetch again through the other Pod: both registrations must survive.
  await Promise.all([api(`/api/session/${id}/endpoint/8081`, "GET", undefined, second), api(`/api/session/${id}/endpoint/8082`)])
  check("跨 Pod 并发注册的两个真实公网 token 网关均可访问", { ports: [8081,8082] })
  await staleScan(id, false)
  await shell(id, "cat /workspace/audit-marker.txt", "vercel-audit-marker", second)
  await staleScan(id, true)
  await shell(id, "cat /workspace/audit-marker.txt", "vercel-audit-marker")
  check("竞争后新旧 Pod 均可操作同一持久工作区", {})
  report.passed = true
} catch (error) { report.error = error.message; console.error(`✗ ${error.message}`); process.exitCode = 1 }
finally {
  if (id) report.binding = row(id)
  await writeFile(`${out}/checks.json`, JSON.stringify(report, null, 2))
}
