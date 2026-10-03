// 创建专用会话：同一活跃沙箱连续 S1/S2，再从 S2 恢复并创建 S3。
// 沙箱和快照只经 SaaS API 创建；平台接口只读，用于诊断与镜像引用确认。
import { readFileSync, writeFileSync } from "node:fs"

const base = "http://127.0.0.1:4096"
const platform = `http://${process.env.OPENCODE_SANDBOX_DOMAIN}`
const headers = {
  "Content-Type": "application/json",
  Authorization: "Basic " + Buffer.from(`${process.env.OPENCODE_SERVER_USERNAME ?? "opencode"}:${process.env.OPENCODE_SERVER_PASSWORD ?? process.env.OPENCODE_PASSWORD ?? ""}`).toString("base64"),
}
const platformHeaders = { "OPEN-SANDBOX-API-KEY": process.env.OPENCODE_SANDBOX_API_KEY ?? "" }
const db = new Bun.SQL(process.env.OPENCODE_DATABASE_URL)
const out = process.env.PROBE_OUTPUT ?? "/tmp/snapshot-layer-confirmation.json"
const report = process.env.PROBE_RESUME === "1"
  ? JSON.parse(readFileSync(out, "utf8"))
  : { startedAt: new Date().toISOString(), snapshots: [], sandboxes: [], commands: [], diagnostics: [], passed: false }
const save = () => writeFileSync(out, JSON.stringify(report, null, 2))
const log = (step, data) => console.log(JSON.stringify({ step, ...data }))
const assert = (ok, message) => { if (!ok) throw new Error(message) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function api(method, path, body) {
  const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(960000) })
  assert(r.ok, `${method} ${path}: HTTP ${r.status}`)
  const t = await r.text()
  return t ? JSON.parse(t) : null
}

async function command(sid, script) {
  const timeoutSeconds = Number(process.env.PROBE_COMMAND_TIMEOUT_SEC ?? 120)
  assert(Number.isInteger(timeoutSeconds) && timeoutSeconds >= 1 && timeoutSeconds <= 900, "命令超时必须1–900秒")
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), (timeoutSeconds + 60) * 1000)
  let reader
  let pump
  let ended
  let error
  const marker = `LAYER_OK_${Date.now()}`
  try {
    const r = await fetch(`${base}/api/session/${sid}/event`, { headers, signal: ctl.signal })
    assert(r.ok && r.body, `SSE HTTP ${r.status}`)
    reader = r.body.getReader()
    pump = (async () => {
      try {
        let buf = ""
        const decoder = new TextDecoder()
        while (!ended) {
          const chunk = await reader.read()
          if (chunk.done) { if (!ctl.signal.aborted) error = new Error("SSE提前关闭"); break }
          buf += decoder.decode(chunk.value, { stream: true })
          let i
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
            if (!line.startsWith("data:")) continue
            let e
            try { e = JSON.parse(line.slice(5).trim()) } catch { continue }
            if (e.type === "session.shell.ended") ended = e
          }
        }
      } catch (e) { if (!ctl.signal.aborted) error = e }
    })()
    await api("POST", `/api/session/${sid}/shell`, { command: `set -eu; cd /workspace; ${script}; echo ${marker}`, timeoutSeconds })
    while (!ended) { if (error) throw error; assert(!ctl.signal.aborted, "命令超时"); await sleep(100) }
    const raw = ended.data?.output
    const stdout = typeof raw === "string" ? raw : String(raw?.output ?? "")
    assert(ended.data?.shell?.exit === 0 && stdout.includes(marker), `命令校验失败：${stdout.slice(-400)}`)
    const result = { exit: 0, output: stdout.replace(marker, "").trim() }
    report.commands.push(result); save()
    return result
  } finally {
    clearTimeout(timer); ctl.abort()
    if (reader) await reader.cancel().catch(() => {})
    if (pump) await pump
  }
}

// 只保存版本/镜像等指定字段，不保存 Pod 环境变量、Secret 或凭据。
function projection(value, path = "", found = []) {
  if (!value || typeof value !== "object") return found
  for (const [key, entry] of Object.entries(value)) {
    const at = path ? `${path}.${key}` : key
    if (/^(env|envFrom|auth|secrets?|managedFields|annotations)$/i.test(key)) continue
    if (typeof entry === "string" && /^(image|imageID|imageUri|apiVersion|namespace|nodeName|containerRuntimeVersion|version)$/i.test(key)) found.push({ path: at, value: entry })
    else if (entry && typeof entry === "object") projection(entry, at, found)
  }
  return found
}

async function inspect(sandboxID, label) {
  const r = await fetch(`${platform}/sandboxes/${sandboxID}`, { headers: platformHeaders, signal: AbortSignal.timeout(15000) })
  assert(r.ok, `平台沙箱只读查询 HTTP ${r.status}`)
  const item = await r.json()
  const safe = { label, id: item.id, imageURI: item.image?.uri, snapshotId: item.snapshotId, platform: item.platform, status: item.status }
  report.sandboxes.push(safe); log("sandbox", safe)
  const diag = await fetch(`${platform}/sandboxes/${sandboxID}/diagnostics/inspect`, { headers: platformHeaders, signal: AbortSignal.timeout(15000) })
  // 此远端诊断接口可能返回文本/YAML，而不是 OpenAPI 未声明的 JSON。
  const text = await diag.text()
  let parsed
  try { parsed = JSON.parse(text) } catch {}
  report.diagnostics.push({ label, status: diag.status, contentType: diag.headers.get("content-type"), fields: parsed ? projection(parsed) : [], nonJSON: !parsed })
  save()
}

async function snapshot(sid, label) {
  const source = (await db`select id,state from sandbox where session_id=${sid}`)[0]
  assert(source?.state === "running", "源沙箱不是 running")
  const result = await api("POST", `/api/session/${sid}/snapshot`)
  const id = result?.data?.snapshotID
  assert(typeof id === "string", "快照响应缺少ID")
  const deadline = Date.now() + 960000
  while (Date.now() < deadline) {
    const row = (await db`select id,state,source_sandbox_id,manifest_token from session_snapshot where id=${id}`)[0]
    if (row?.state === "ready") {
      assert(row.source_sandbox_id === source.id, "快照源代际错误")
      report.snapshots.push({ label, ...row }); save(); log("snapshot_ready", { label, id, source: source.id })
      await inspect(source.id, label)
      return id
    }
    assert(row?.state !== "failed", `快照失败：${label}`)
    await sleep(1000)
  }
  throw new Error(`快照超时：${label}`)
}

export { command, report, db, save, api, inspect, snapshot }

if (import.meta.main) {
try {
  assert(process.env.OPENCODE_SANDBOX_SNAPSHOT_WAIT_SEC === "900", "wait配置必须为900")
  const created = report.sid ? null : await api("POST", "/api/session", { sandbox: { cpu: "1", memory: "2Gi", image: process.env.OPENCODE_SANDBOX_IMAGE, persistMode: "snapshot" } })
  const sid = report.sid ?? created?.data?.id
  assert(typeof sid === "string", "会话创建缺少ID")
  report.sid = sid; save(); log("session", { sid })
  if (report.snapshots.length === 0) {
    await command(sid, "head -c 8388608 /dev/urandom > layer-payload.bin; sha256sum layer-payload.bin > payload.sha256; printf 'v1\\n' > layer-edit.txt")
    await snapshot(sid, "S1_活跃沙箱_8MiB")
  }
  await command(sid, "sha256sum -c payload.sha256; printf 'v2\\n' >> layer-edit.txt")
  const s2 = await snapshot(sid, "S2_同一活跃沙箱_小改")
  assert(report.snapshots[0].source_sandbox_id === report.snapshots[1].source_sandbox_id, "S1/S2不在同一沙箱")
  await api("POST", `/api/session/${sid}/kill-sandbox`)
  const killed = (await db`select state from sandbox where session_id=${sid}`)[0]
  assert(killed?.state === "destroyed", "销毁未完成")
  await command(sid, "sha256sum -c payload.sha256; grep -q v2 layer-edit.txt; printf 'v3\\n' >> layer-edit.txt")
  const restored = (await db`select id,state from sandbox where session_id=${sid}`)[0]
  assert(restored?.id !== report.snapshots[1].source_sandbox_id, "恢复未创建新沙箱")
  await inspect(restored.id, "恢复自S2")
  assert(report.sandboxes.at(-1).snapshotId === s2, "未从S2恢复")
  const s3 = await snapshot(sid, "S3_恢复后_小改")
  await api("POST", `/api/session/${sid}/kill-sandbox`)
  await command(sid, "sha256sum -c payload.sha256; grep -q v3 layer-edit.txt")
  const third = (await db`select id,state from sandbox where session_id=${sid}`)[0]
  await inspect(third.id, "恢复自S3")
  assert(report.sandboxes.at(-1).snapshotId === s3, "未从S3恢复")
  delete report.error
  report.passed = true; log("PASS", { sid, snapshots: report.snapshots.length })
  // 为后续 OCI 层核验保留这一个专用会话和快照；确认完成后再按ID清理。
} catch (e) {
  report.error = String(e); process.exitCode = 1; log("FAIL", { error: String(e), sid: report.sid })
} finally {
  report.finishedAt = new Date().toISOString(); save(); await db.close()
}
}
