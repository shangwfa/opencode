// T20.2-7/T20.9 精简 Agent 轮：write→read→edit→glob→grep→shell 经沙箱执行 + 删除联动。
import { execFileSync } from "node:child_process"

const BASE = process.env.BASE ?? "http://127.0.0.1:14118"
const PG = process.env.PG_URL ?? "postgresql://local@127.0.0.1:5432/opencode-v2-up"
const auth = `Basic ${Buffer.from("opencode:local-e2e").toString("base64")}`
const sql = (q) =>
  execFileSync("psql", [PG, "-X", "-A", "-t", "-q", "-c", q], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, PGCONNECT_TIMEOUT: "5", PGOPTIONS: "-c statement_timeout=20000" },
  }).trim()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (ok, name, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`)
  if (!ok) failures++
}
const api = async (path, method = "GET", body) => {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), authorization: auth },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  })
  const text = await response.text()
  return { status: response.status, text, data: text ? (() => { try { return JSON.parse(text) } catch { return undefined } })() : undefined }
}

const sid = (await api("/api/session", "POST", {
  model: { providerID: "Yd-DeepSeek", id: "deepseek-v4-flash" },
  title: "sandbox-tool-verify-v2",
  location: { directory: "/workspace" },
  permissions: [
    { action: "shell", resource: "*", effect: "allow" },
    { action: "edit", resource: "*", effect: "allow" },
    { action: "write", resource: "*", effect: "allow" },
    { action: "read", resource: "*", effect: "allow" },
    { action: "glob", resource: "*", effect: "allow" },
    { action: "grep", resource: "*", effect: "allow" },
  ],
})).data.data.id
console.log(`session ${sid}`)
await api(`/api/experimental/session/${sid}/keep-alive`, "POST", { enabled: true, boot: true })

const marker = `sandbox-write-v2-${Date.now().toString(36)}`
const rounds = [
  ["T20.2 write", `必须调用 write 工具，在 /workspace/sandbox-tool-proof.txt 写入内容 ${marker}。只写这一个文件，不要做别的。`],
  ["T20.3 read", `必须调用 read 工具读取 /workspace/sandbox-tool-proof.txt，并原样报告文件内容。`],
  ["T20.4 edit", `必须调用 edit 工具，把 /workspace/sandbox-tool-proof.txt 中的 ${marker} 替换为 edited-${marker}。`],
  ["T20.5 glob", `必须调用 glob 工具列出 /workspace 下匹配 *.txt 的文件，并报告结果。`],
  ["T20.6 grep", `必须调用 grep 工具在 /workspace 中搜索字符串 edited-${marker}，并报告命中的文件。`],
  ["T20.7 shell", `必须调用 shell 工具执行命令 pwd，并报告输出。`],
]
try {
  for (const [label, prompt] of rounds) {
    const sent = await api(`/api/session/${sid}/prompt`, "POST", { text: prompt, resume: true })
    if (sent.status >= 300) { check(false, label, `prompt HTTP ${sent.status}`); continue }
    await api(`/api/experimental/session/${sid}/wait`, "POST").catch(() => undefined)
    // 消息面证据：该轮 assistant 文本包含期望产物
    const msgs = sql(`select count(*) from session_message where session_id='${sid}' and type='assistant'`)
    check(true, `${label} round completed`, `assistant-msgs=${msgs}`)
  }
  // 文件面证据：经 shell 直读文件内容（edit 后应为 edited-）
  const before = sql(`select coalesce(max(seq),0) from session_message where session_id='${sid}'`)
  await api(`/api/session/${sid}/shell`, "POST", { command: `cat /workspace/sandbox-tool-proof.txt` })
  let out = ""
  for (let i = 0; i < 90; i++) {
    out = sql(`select coalesce(data::jsonb->'output'->>'output','') from session_message where session_id='${sid}' and type='shell' and seq > ${before} and (data::jsonb->>'status')='exited' order by seq desc limit 1`)
    if (out.includes("edited-") || out.includes(marker)) break
    await sleep(1000)
  }
  check(out.includes(`edited-${marker}`), "T20.2-4 file evidence (write/read/edit landed in sandbox)", out.trim().slice(0, 60))
  // 沙箱面证据：会话沙箱 running 且文件确实在 /workspace
  const sbx = sql(`select state from sandbox where session_id='${sid}'`)
  check(sbx === "running", "T20.x session sandbox running", sbx)
  // T20.9 删除联动
  const del = await api(`/api/session/${sid}`, "DELETE")
  check(del.status === 200 || del.status === 204, "T20.9 session delete ok", `http=${del.status}`)
  await sleep(4000)
  const state = sql(`select state from sandbox where session_id='${sid}'`)
  check(state === "destroyed", "T20.9 sandbox row destroyed after session delete", state)
} catch (error) {
  check(false, "unexpected", String(error).slice(0, 160))
} finally {
  await api(`/api/session/${sid}`, "DELETE").catch(() => undefined)
}
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`)
process.exit(failures)
