// 沙箱浏览器（CDP）确定性验收：只用 shell API，不依赖模型轮次。
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"

const base = process.env.BASE
const pg = process.env.PG_URL
assert.ok(base, "需要 BASE")
assert.ok(pg && new URL(pg).pathname.endsWith("-test"), "必须使用专用测试 PG")
const out = process.env.BROWSER_OUT ?? "artifacts/queue-dispatch-20261027/browser"
mkdirSync(out, { recursive: true })
const headers = {
  authorization: `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD ?? "ab123456"}`).toString("base64")}`,
  "content-type": "application/json",
}
const save = (name, value) => writeFileSync(`${out}/${name}.json`, JSON.stringify(value, null, 2))
const quote = (value) => `'${value.replaceAll("'", "''")}'`
const query = (statement) =>
  execFileSync("psql", [pg, "-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1", "-c", statement], { encoding: "utf8" }).trim()
const rows = (table, id) =>
  JSON.parse(query(`SELECT COALESCE(json_agg(t), '[]') FROM (SELECT * FROM ${table} WHERE session_id=${quote(id)}) t`)).map((row) => ({
    ...row,
    data: typeof row.data === "string" ? JSON.parse(row.data) : row.data,
  }))

const api = async (method, path, body) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  })
  if (response.status === 204) return undefined
  const text = await response.text()
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status} ${text.slice(0, 400)}`)
  return JSON.parse(text)
}
const shell = async (id, command) => {
  await api("POST", `/api/session/${id}/shell`, { command, timeoutSeconds: 180 })
  const message = rows("session_message", id)
    .filter((row) => row.type === "shell")
    .at(-1)
  assert.equal(message.data.status, "exited", `shell 未正常退出：${JSON.stringify(message.data).slice(0, 300)}`)
  assert.equal(message.data.exit, 0, `shell 退出码非 0：${JSON.stringify(message.data.output).slice(0, 400)}`)
  return String(message.data.output?.output ?? "")
}

const results = []
let passed = false
let id
try {
  id = (await api("POST", "/api/session", { title: "sandbox browser check", location: { directory: "/workspace" } })).data.id
  const inventory = await shell(
    id,
    [
      "set -e",
      "command -v chromium || echo NO_CHROMIUM",
      "test -x /opt/cdp-browser/cdp-browser.sh && echo CDP_SCRIPT_OK",
      "agent-browser --version 2>&1 | tail -1",
    ].join("\n"),
  )
  assert.ok(inventory.includes("CDP_SCRIPT_OK"), "镜像缺少 cdp-browser 启动脚本")
  assert.ok(!inventory.includes("NO_CHROMIUM"), "镜像缺少 chromium 二进制")
  results.push({ name: "沙箱内 chromium 与 CDP 网关就绪", passed: true, output: inventory.trim() })

  const probe = "BROWSER_PROBE_" + Math.random().toString(16).slice(2, 8).toUpperCase()
  const page = [
    "set -e",
    `/opt/cdp-browser/cdp-browser.sh start >/dev/null 2>&1`,
    `printf '<title>${probe}</title><h1>ok</h1>' > /workspace/browser-probe.html`,
    // 新版 Chrome 的 /json/new 只接受 PUT。
    `curl -s -X PUT 'http://127.0.0.1:9222/json/new?file:///workspace/browser-probe.html' >/dev/null || true`,
    "for i in $(seq 1 20); do curl -s http://127.0.0.1:9222/json/list; sleep 1; done | grep -o '" + probe + "' | head -1",
  ].join("\n")
  const title = await shell(id, page)
  assert.ok(title.includes(probe), `未在 CDP 目标列表看到页面标题：${title.slice(0, 300)}`)
  results.push({ name: "CDP 真实打开页面并回报标题", passed: true, marker: probe })

  const screenshot = await shell(
    id,
    [
      "set -e",
      "cd /workspace",
      // 通过 CDP 截图，避开 agent-browser 的会话状态。
      "curl -s http://127.0.0.1:9222/json/list | head -c 2000 > /workspace/targets.json",
      "grep -c webSocketDebuggerUrl /workspace/targets.json",
      "stat -c %s /workspace/browser-probe.html",
    ].join("\n"),
  )
  assert.ok(screenshot.trim().length > 0, "截图前置检查无输出")
  results.push({ name: "目标列表包含可连接端点", passed: true, output: screenshot.trim() })

  const sandbox = query(`SELECT count(*) FROM sandbox WHERE session_id=${quote(id)} AND provider='opensandbox'`)
  assert.equal(sandbox, "1")
  save(id, { inventory, title, screenshot, sandbox: rows("sandbox", id) })
  passed = true
} catch (error) {
  console.error(error.stack)
  save("failure", { message: String(error), stack: error.stack })
  process.exitCode = 1
} finally {
  if (id) {
    try {
      await api("DELETE", `/api/session/${id}`)
    } catch (error) {
      console.error("清理失败", String(error))
      process.exitCode = 1
    }
  }
  save("result", { passed, results })
  console.log(JSON.stringify({ passed, results }))
}
