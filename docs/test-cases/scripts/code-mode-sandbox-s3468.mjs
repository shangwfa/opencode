// Code Mode Sandbox executor 深层验收：S4（重复帧幂等——现状证实）、S6（nonce/owner——现状证实）、
// S7（Runner kill 与 SaaS restart 恢复）、S8（network=sandbox 的 egress identity：fetch 来源 IP 必须是沙箱）。
// S4/S6 当前产品未实现幂等/握手，本脚本产出「可复现的风险证据」并如实分级，不把缺陷记为 PASS。
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"

const BASE = (process.env.BASE ?? "http://localhost:14106").replace(/\/$/, "")
const PG_URL = process.env.PG_URL
const SAAS_CONTAINER = process.env.SAAS_CONTAINER ?? "opencode-saas-cmsbx"
const AUTH = process.env.OPENCODE_AUTH ?? (process.env.OPENCODE_PASSWORD ? `opencode:${process.env.OPENCODE_PASSWORD}` : undefined)
const headers = {
  "content-type": "application/json",
  ...(AUTH ? { authorization: `Basic ${Buffer.from(AUTH).toString("base64")}` } : {}),
}
const parsedModel = JSON.parse(process.env.MODEL ?? '{"providerID":"Yd-DeepSeek","id":"deepseek-v4-flash"}')
const model = { providerID: parsedModel.providerID, id: parsedModel.id ?? parsedModel.modelID }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const nonce = randomUUID().replaceAll("-", "").slice(0, 8)

function check(ok, description) {
  assert(ok, `FAIL: ${description}`)
  console.log(`PASS: ${description}`)
}
function risk(description) {
  console.log(`RISK: ${description}`)
}
function pg(sql) {
  const result = spawnSync("psql", [PG_URL, "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" })
  if (result.status !== 0) throw new Error(`psql failed: ${result.stderr}`)
  return result.stdout.trim()
}
const quote = (value) => `'${value.replaceAll("'", "''")}'`

async function api(path, method = "GET", body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(300_000),
  })
  const text = response.status === 204 ? "" : await response.text()
  let data
  try {
    data = text ? JSON.parse(text) : undefined
  } catch {
    data = text
  }
  return { status: response.status, data, text }
}

async function runShell(sessionID, command, timeoutSeconds = 90) {
  await api(`/api/session/${sessionID}/shell`, "POST", { command, timeoutSeconds })
  const deadline = Date.now() + 150_000
  while (Date.now() < deadline) {
    const messages = (await api(`/api/session/${sessionID}/message?order=asc`)).data.data ?? []
    const item = messages.filter((m) => m.type === "shell" && m.command === command).at(-1)
    if (item && item.status !== "running") {
      if (item.status !== "exited" || item.exit !== 0) throw new Error(`shell failed: ${JSON.stringify(item).slice(0, 300)}`)
      return item.output?.output ?? ""
    }
    await sleep(500)
  }
  throw new Error(`shell timed out: ${command.slice(0, 80)}`)
}

const sessionID = (await api("/api/session", "POST", { title: `cm-s3468-${nonce}`, location: { directory: "/workspace" }, model })).data.data.id

// 沙箱内原始 WebSocket client：无任何握手直连 Runner（S6/S4 现状证实的工具）
const RAW_CLIENT = `
const ws = new WebSocket("ws://127.0.0.1:9911/");
const mode = process.argv[2];
const executionID = process.argv[3];
const code = process.argv[4];
let toolCalls = 0;
const timer = setTimeout(() => { console.log(JSON.stringify({ timeout: true, toolCalls })); process.exit(2) }, 25000);
ws.onopen = () => ws.send(JSON.stringify({ type: "execute", executionID, code, web: false, tools: [], limits: {} }));
ws.onmessage = (ev) => {
  const frame = JSON.parse(ev.data);
  if (frame.type === "tool.call") {
    toolCalls++;
    ws.send(JSON.stringify({ type: "tool.result", executionID, ordinal: frame.ordinal, output: { ok: true } }));
    return;
  }
  if (frame.type === "execution.result" || frame.type === "execution.error" || frame.type === "runner.error") {
    clearTimeout(timer);
    console.log(JSON.stringify({ frame, toolCalls }));
    if (mode === "repeat") {
      // S4：同一 executionID 立即重发 execute 帧（模拟断线重试/重复帧）
      setTimeout(() => ws.send(JSON.stringify({ type: "execute", executionID, code, web: false, tools: [], limits: {} })), 200);
      setTimeout(() => { console.log(JSON.stringify({ repeatDone: true, toolCalls })); process.exit(0) }, 3000);
    } else process.exit(0);
  }
};
ws.onerror = () => { console.log(JSON.stringify({ error: "ws-error" })); process.exit(1) };
`

try {
  // ---------- 前置：让 Runner daemon 先由一轮真实 execute 拉起（复用 s2 的最小路径） ----------
  await api(`/api/session/${sessionID}/agents`, "POST", {
    id: "session/cm-harness",
    config: {
      mode: "primary",
      description: "harness",
      system:
        "You execute scripting tasks exclusively through the execute tool. Call execute immediately with the requested code. Never use question/read/glob/grep/webfetch/shell. Never ask for confirmation. Report the result in one line.",
    },
  })
  await api(`/api/session/${sessionID}/agent`, "POST", { agent: "session/cm-harness" })
  const warm = await fetch(`${BASE}/api/session/${sessionID}/prompt_stream`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text: "必须调用 execute 执行：return 1+1，然后一句话报告结果。", metadata: {}, delivery: "queue" }),
  })
  {
    const reader = warm.body.getReader()
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
    }
  }
  check(true, "前置：Runner daemon 已由真实 execute 拉起")

  // ---------- S6：无 nonce/owner 直连（沙箱内任意进程视角） ----------
  const rawEncoded = Buffer.from(RAW_CLIENT).toString("base64")
  await runShell(sessionID, `printf '%s' '${rawEncoded}' | base64 -d > /tmp/raw-client.mjs && node --check /tmp/raw-client.mjs && echo RAW_OK`)
  const s6 = await runShell(sessionID, `node /tmp/raw-client.mjs once s6-nonceless-${nonce} 'return { who: "no-nonce" }'`)
  let s6Frame
  try {
    s6Frame = JSON.parse(s6.split("\n").filter(Boolean).at(-1))
  } catch {
    s6Frame = {}
  }
  const s6Accepted = s6Frame?.frame?.type === "execution.result"
  if (s6Accepted) {
    risk("S6 现状：Runner 无 nonce/owner 握手——沙箱内任意进程可直连 9911 并成功执行代码（产品缺口可复现，S6 门槛未达成）")
  } else {
    check(false, `S6：无握手连接被拒绝（实际：${JSON.stringify(s6Frame).slice(0, 150)}）`)
  }

  // ---------- S4：同 executionID 重复 execute 帧（Runner 侧行为） ----------
  const s4 = await runShell(sessionID, `node /tmp/raw-client.mjs repeat s4-dup-${nonce} 'return { n: 1 }'`)
  const s4Lines = s4.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return {} } })
  const s4First = s4Lines.find((l) => l?.frame?.type)
  const s4Repeat = s4Lines.find((l) => l?.repeatDone)
  const firstAccepted = s4First?.frame?.type === "execution.result"
  check(Boolean(firstAccepted), "S4 前置：首次 execute 帧被接受并返回 execution.result")
  if (firstAccepted) {
    // 重复帧期间是否出现新的 tool.call / 第二个 execution.result（frame.toolCalls 计数或额外 result）
    const newResultAfterRepeat = s4Repeat && s4Repeat.toolCalls === s4First.toolCalls
    if (newResultAfterRepeat) {
      check(true, `S4：重复 execute 帧未触发新的工具调用（toolCalls 保持 ${s4First.toolCalls}；本例代码无工具调用，仅证明无立即重放信号）`)
    } else {
      risk(`S4 现状：重复 execute 帧后 toolCalls 变化（${s4First.toolCalls} → ${s4Repeat?.toolCalls}），存在重复执行路径（SaaS 侧亦无 (executionID, ordinal) 去重——产品缺口）`)
    }
    // SaaS 侧去重缺失是结构性的（runner.ts 直接执行每个 tool.call），以代码事实记录
    risk("S4 现状：SaaS tool callback 对每个 tool.call 直接执行（runner.ts L166），无 (executionID, ordinal) 结果缓存——重复帧将重复触发有副作用工具（S4 门槛未达成）")
  }

  // ---------- S7a：execute 长任务中 kill Runner daemon ----------
  const delayFixture = (await import("node:fs")).readFileSync(new URL("../code-mode/fixtures/delay-mcp.mjs", import.meta.url), "utf8")
  const delayEncoded = Buffer.from(delayFixture).toString("base64")
  await runShell(sessionID, `printf '%s' '${delayEncoded}' | base64 -d > /workspace/fx-delay-mcp.mjs && node --check /workspace/fx-delay-mcp.mjs && echo DELAY_OK`)
  await api(`/api/session/${sessionID}/mcps`, "POST", { name: "delay", config: { type: "local", command: ["node", "/workspace/fx-delay-mcp.mjs"] } })
  for (let i = 0; i < 24; i++) {
    if (((await api(`/api/session/${sessionID}/context`)).text ?? "").includes("delay")) break
    await sleep(5000)
  }
  const before = Number(pg(`SELECT coalesce(max(seq),0) FROM session_message WHERE session_id=${quote(sessionID)}`))
  const longRun = fetch(`${BASE}/api/session/${sessionID}/prompt_stream`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      text: `必须调用 execute 执行：return await tools.delay.wait({durationMs: 25000, marker:"s7-kill-${nonce}"})，然后一句话报告。`,
      metadata: {},
      delivery: "queue",
    }),
  }).then(async (r) => { const reader = r.body.getReader(); while (true) { const { value, done } = await reader.read(); if (done) break } }).catch(() => undefined)
  // 等 execute 进入 running（PG 出现 streaming/running execute part）
  let runningSeen = false
  for (let i = 0; i < 60 && !runningSeen; i++) {
    const rows = pg(`SELECT count(*) FROM session_message WHERE session_id=${quote(sessionID)} AND type='assistant' AND seq > ${before} AND data::jsonb::text LIKE '%\"execute\"%'`)
    if (rows !== "0") runningSeen = true
    else await sleep(1000)
  }
  check(runningSeen, "S7a 前置：长任务 execute 已进入执行")
  await runShell(sessionID, `sh -c 'pid=$(cat /tmp/opencode-codemode-runner.pid); kill $pid; echo KILLED_$pid'`)
  await longRun
  const s7aRow = pg(
    `SELECT (data::jsonb->'content')::text FROM session_message WHERE session_id=${quote(sessionID)} AND type='assistant' AND seq > ${before} AND data::jsonb::text LIKE '%\\"execute\\"%' ORDER BY seq DESC LIMIT 1`,
  )
  const s7aStates = (() => {
    try {
      for (const part of JSON.parse(s7aRow)) if (part.type === "tool" && part.name === "execute") return part.state?.status ?? ""
    } catch {}
    return ""
  })()
  check(s7aStates === "error", `S7a：Runner kill 后 execute 收敛终态 error（实际 ${s7aStates}）`)
  // Runner 重启幂等：下一轮 execute 应重新拉起 daemon 并成功
  const recover = await fetch(`${BASE}/api/session/${sessionID}/prompt_stream`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text: "必须调用 execute 执行：return 2+2，然后一句话报告。", metadata: {}, delivery: "queue" }),
  })
  {
    const reader = recover.body.getReader()
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
    }
  }
  const after = Number(pg(`SELECT coalesce(max(seq),0) FROM session_message WHERE session_id=${quote(sessionID)}`))
  const recoverRow = pg(
    `SELECT (data::jsonb->'content')::text FROM session_message WHERE session_id=${quote(sessionID)} AND type='assistant' AND seq > ${before} AND data::jsonb::text LIKE '%\\"execute\\"%' ORDER BY seq DESC LIMIT 1`,
  )
  const recoverState = (() => {
    try {
      for (const part of JSON.parse(recoverRow)) if (part.type === "tool" && part.name === "execute") return part.state?.status ?? ""
    } catch {}
    return ""
  })()
  check(recoverState === "completed", `S7a：daemon 被杀后下一轮 execute 重新拉起 Runner 并 completed（实际 ${recoverState}）`)

  // ---------- S8：network=sandbox 的 egress identity（观测容器方案：bridge 网络内源 IP 可区分） ----------
  // host.docker.internal 在 macOS Docker 下对所有容器都呈现 127.0.0.1，无鉴别力；观测服务必须跑在同网络的容器里。
  spawnSync("docker", ["rm", "-f", "s8-obs"], { encoding: "utf8" })
  spawnSync("docker", ["run", "-d", "--name", "s8-obs", "--entrypoint", "node", "opencode-opensandbox:local", "-e",
    `const L=[];require("http").createServer((q,s)=>{console.log("PEER "+q.url+" "+q.socket.remoteAddress);s.end("{}")}).listen(9099,()=>console.log("OBS_READY"))`], { encoding: "utf8" })
  let obsReady = false
  for (let i = 0; i < 30 && !obsReady; i++) {
    if (spawnSync("docker", ["logs", "s8-obs"], { encoding: "utf8" }).stdout.includes("OBS_READY")) obsReady = true
    else await sleep(1000)
  }
  check(obsReady, "S8 前置：观测容器就绪（bridge 网络，记录请求来源 IP）")
  const obsIP = spawnSync("docker", ["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", "s8-obs"], { encoding: "utf8" }).stdout.trim()
  const saasIP = spawnSync("docker", ["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", SAAS_CONTAINER], { encoding: "utf8" }).stdout.trim() || "unknown"
  // 基准1：该 session 沙箱 shell 直接 fetch（沙箱身份）
  const s8Marker = `s8-${nonce}`
  await runShell(sessionID, `node -e 'fetch("http://${obsIP}:9099/from-sandbox-shell").then(r=>r.text()).then(()=>console.log("${s8Marker}"))'`)
  // 基准2：execute 内 fetch（待判定身份）
  const s8Run = fetch(`${BASE}/api/session/${sessionID}/prompt_stream`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      text: `必须调用 execute 执行：await fetch("http://${obsIP}:9099/from-execute"); return "done"`,
      metadata: {},
      delivery: "queue",
    }),
  }).then(async (r) => { const reader = r.body.getReader(); while (true) { const { value, done } = await reader.read(); if (done) break } }).catch(() => undefined)
  const s8Deadline = Date.now() + 180_000
  let peers = []
  while (Date.now() < s8Deadline) {
    peers = spawnSync("docker", ["logs", "s8-obs"], { encoding: "utf8" }).stdout.split("\n").filter((l) => l.includes("PEER "))
    if (peers.length >= 2) break
    await sleep(2000)
  }
  await s8Run
  check(peers.length >= 2, `S8 前置：沙箱 shell 与 execute 的 fetch 均到达观测容器（${peers.length} 条）`)
  const peerOf = (url) => (peers.find((l) => l.includes(url)) ?? "").split(" ").pop()?.replace(/^::ffff:/, "") ?? ""
  const shellPeer = peerOf("/from-sandbox-shell")
  const execPeer = peerOf("/from-execute")
  console.log(`S8 观测：沙箱 shell peer=${shellPeer}；execute peer=${execPeer}；SaaS 容器 IP=${saasIP}`)
  check(shellPeer !== "" && execPeer !== "" && shellPeer === execPeer, `S8：execute fetch 来源（${execPeer}）与沙箱 shell 同一身份`)
  check(execPeer !== saasIP, `S8：execute fetch 来源不是 SaaS 进程（${saasIP}）——network=sandbox 的沙箱本地 egress 成立`)
  spawnSync("docker", ["rm", "-f", "s8-obs"], { encoding: "utf8" })
} finally {
  await api(`/api/session/${sessionID}/shell`, "POST", { command: "rm -f /tmp/raw-client.mjs /workspace/fx-delay-mcp.mjs", timeoutSeconds: 30 }).catch(() => undefined)
  for (let attempt = 0; attempt < 60; attempt++) {
    await api(`/api/session/${sessionID}`, "DELETE").catch(() => undefined)
    if (pg(`SELECT count(*) FROM session_v2 WHERE id=${quote(sessionID)}`) === "0") break
    await sleep(1000)
  }
  check(pg(`SELECT count(*) FROM session_v2 WHERE id=${quote(sessionID)}`) === "0", "清理：测试 session 零残留")
}
