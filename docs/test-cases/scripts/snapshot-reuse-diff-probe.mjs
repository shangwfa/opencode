// diff 实证：恢复后 manifest 与快照时 manifest 的差异行——是目录(%y=d)还是文件？差异字段是什么？
const base = "http://127.0.0.1:4096"
const image = process.env.OPENCODE_SANDBOX_IMAGE
const headers = {
  "Content-Type": "application/json",
  Authorization: "Basic " + Buffer.from((process.env.OPENCODE_SERVER_USERNAME ?? "opencode") + ":" + (process.env.OPENCODE_SERVER_PASSWORD ?? process.env.OPENCODE_PASSWORD ?? "")).toString("base64"),
}
const t0 = Date.now()
const log = (step, data = {}) => console.log(JSON.stringify({ step, at: `${((Date.now() - t0) / 1000).toFixed(0)}s`, ...data }))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const api = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined })
  const text = await r.text()
  let d = null
  try { d = JSON.parse(text) } catch {}
  return { status: r.status, ok: r.ok, data: d, text }
}
async function runCommand(sid, command, timeoutSeconds = 900) {
  const stream = await fetch(base + `/api/session/${sid}/event`, { headers })
  const reader = stream.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const events = []
  ;(async () => {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (line.startsWith("data: ")) { try { events.push(JSON.parse(line.slice(6))) } catch {} }
      }
    }
  })()
  await api("POST", `/api/session/${sid}/shell`, { command, timeoutSeconds })
  const deadline = Date.now() + (timeoutSeconds + 60) * 1000
  while (Date.now() < deadline) {
    const ended = events.find((e) => e.type === "session.shell.ended")
    if (ended) {
      try { reader.cancel() } catch {}
      const raw = ended.data?.output
      return { exit: ended.data?.shell?.exit ?? null, output: typeof raw === "string" ? raw : String(raw?.output ?? "") }
    }
    await sleep(2000)
  }
  try { reader.cancel() } catch {}
  throw new Error("命令超时")
}
let sid = null
try {
  const created = await api("POST", "/api/session", { sandbox: { cpu: "2", memory: "4Gi", image, persistMode: "snapshot" } })
  sid = created.data.data.id
  await runCommand(sid, `cd /workspace && printf '{"name":"diff-probe","private":true,"dependencies":{"next":"16.3.8","react":"19.3.0","react-dom":"19.3.0"}}' > package.json && printf 'store-dir=.pnpm-store\\nregistry=https://registry.npmmirror.com/\\n' > .npmrc && pnpm install 2>&1 | tail -1 && echo SETUP_OK && find /workspace -type f | wc -l`)
  // 快照（trigger: kill）→ 恢复
  await api("POST", `/api/session/${sid}/kill-sandbox`)
  const sql = new Bun.SQL(process.env.OPENCODE_DATABASE_URL)
  let ready = false
  for (let i = 0; i < 100 && !ready; i++) {
    const rows = await sql`select state from session_snapshot where session_id = ${sid} order by time_created desc limit 1`
    ready = rows[0]?.state === "ready"
    if (!ready) await sleep(3000)
  }
  log("snapshot1_ready", { ready })

  // 恢复后：重扫 manifest 并 diff（只看差异的结构，不跑完整判定）
  const diff = await runCommand(sid, `bash -c '{ find /workspace -printf "%y %m %s %p %l\\n" && find /workspace -type f -exec sha256sum {} +; } | LC_ALL=C sort > /tmp/now.manifest'
echo "=== 差异行数 ==="; diff /tmp/now.manifest /var/tmp/.opencode-snapshot-manifest | grep -c "^[<>]"
echo "=== 差异样例（前 16 行）==="; diff /tmp/now.manifest /var/tmp/.opencode-snapshot-manifest | head -16
echo "=== 差异类型统计（按 %y 首字符与新旧侧）==="; diff /tmp/now.manifest /var/tmp/.opencode-snapshot-manifest | grep "^<" | awk '{print \$1}' | sort | uniq -c | sort -rn | head -5; echo "--- 快照侧 ---"; diff /tmp/now.manifest /var/tmp/.opencode-snapshot-manifest | grep "^>" | awk '{print \$1}' | sort | uniq -c | sort -rn | head -5
echo "=== 差异路径样例（去掉 sha 行，看 -printf 行的字段差异）==="; diff /tmp/now.manifest /var/tmp/.opencode-snapshot-manifest | grep "^[<>]" | grep -v "^[<>] [0-9a-f]\\{64\\} " | head -12`)
  log("manifest_diff", { exit: diff.exit, output: diff.output })
} catch (error) {
  log("failed", { error: String(error).slice(0, 400) })
} finally {
  if (sid) {
    await api("POST", `/api/session/${sid}/kill-sandbox`).catch(() => {})
    const del = await api("DELETE", `/api/session/${sid}`)
    log("cleanup", { status: del.status })
  }
}
