// 在 Docker SaaS 容器内执行；只通过 SaaS API 创建/操作沙箱，PG 和平台状态只读。
// 端到端、PG 创建到 Ready、平台 Ready 观测分开记录，不宣称为纯 commit 耗时。
import { writeFileSync } from "node:fs"

const base = "http://127.0.0.1:4096"
const output = process.env.PROBE_OUTPUT ?? "/tmp/snapshot-latency-retest.json"
const rounds = Number(process.env.PROBE_ROUNDS ?? 3)
const headers = {
  "Content-Type": "application/json",
  Authorization: "Basic " + Buffer.from(`${process.env.OPENCODE_SERVER_USERNAME ?? "opencode"}:${process.env.OPENCODE_SERVER_PASSWORD ?? process.env.OPENCODE_PASSWORD ?? ""}`).toString("base64"),
}
const platform = `http://${process.env.OPENCODE_SANDBOX_DOMAIN}`
const platformHeaders = { "OPEN-SANDBOX-API-KEY": process.env.OPENCODE_SANDBOX_API_KEY ?? "" }
const db = new Bun.SQL(process.env.OPENCODE_DATABASE_URL)
const report = {
  startedAt: new Date().toISOString(),
  config: { waitSec: process.env.OPENCODE_SANDBOX_SNAPSHOT_WAIT_SEC, domain: process.env.OPENCODE_SANDBOX_DOMAIN, image: process.env.OPENCODE_SANDBOX_IMAGE, rounds },
  sessions: [], samples: [], commands: [], passed: false,
}
const log = (step, data = {}) => console.log(JSON.stringify({ step, at: new Date().toISOString(), ...data }))
const save = () => writeFileSync(output, JSON.stringify(report, null, 2))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const assert = (condition, message) => { if (!condition) throw new Error(message) }
const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`

async function api(method, path, body) {
  const response = await fetch(base + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(960_000),
  })
  const text = await response.text()
  assert(response.ok, `${method} ${path}: HTTP ${response.status} ${text.slice(0, 160)}`)
  return text ? JSON.parse(text) : null
}

async function command(sid, label, script) {
  const start = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 960_000)
  let reader
  let pump
  try {
    const stream = await fetch(`${base}/api/session/${sid}/event`, { headers, signal: controller.signal })
    assert(stream.ok && stream.body, `SSE HTTP ${stream.status}`)
    reader = stream.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    const marker = `PROBE_OK_${Date.now()}`
    let ended = null
    let streamError = null
    pump = (async () => {
      try {
        while (!ended) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let split
          while ((split = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, split).trim()
            buffer = buffer.slice(split + 1)
            if (!line.startsWith("data:")) continue
            let event
            try { event = JSON.parse(line.slice(5).trim()) } catch { continue }
            if (event.type === "session.shell.ended") ended = event
          }
        }
        if (!ended && !controller.signal.aborted) streamError = new Error("SSE 在命令结束前关闭")
      } catch (error) { if (!controller.signal.aborted) streamError = error }
    })()
    await api("POST", `/api/session/${sid}/shell`, {
      command: `bash -o pipefail -c ${quote(`set -eu; cd /workspace; ${script}; echo ${marker}`)}`,
      timeoutSeconds: 900,
    })
    while (!ended) {
      if (streamError) throw streamError
      assert(!controller.signal.aborted, `命令超时：${label}`)
      await sleep(100)
    }
    const raw = ended.data?.output
    const stdout = typeof raw === "string" ? raw : String(raw?.output ?? "")
    const exit = ended.data?.shell?.exit
    assert(exit === 0 && stdout.includes(marker), `命令失败 ${label} exit=${exit} ${stdout.slice(-1000)}`)
    const result = { sid, label, wallMs: Date.now() - start, exit, output: stdout.replace(marker, "").trim() }
    report.commands.push(result)
    save()
    log("command", { sid, label, wallMs: result.wallMs, exit, output: result.output.slice(-500) })
    return result
  } finally {
    clearTimeout(timer)
    controller.abort()
    if (reader) await reader.cancel().catch(() => {})
    if (pump) await pump
  }
}

async function checkpoint(sid, round, label, reuse = false) {
  const before = await db`select id,state from session_snapshot where session_id=${sid}`
  const oldIDs = new Set(before.map((row) => row.id))
  const source = (await db`select id,state from sandbox where session_id=${sid}`)[0]
  assert(source?.state === "running", `源沙箱非 running：${label}`)
  const started = Date.now()
  let requestDone = false
  let requestError = null
  let requestMs = null
  const request = api("POST", `/api/session/${sid}/kill-sandbox`).then(() => {
    requestDone = true
    requestMs = Date.now() - started
  }).catch((error) => { requestError = error })
  // 在 POST 进行期间独立观测，避免同步 API 响应掩盖平台完成时刻。
  let fresh = null
  let operation = null
  let pgReadyObservedMs = null
  let remoteReadyObservedMs = null
  let remote = null
  let remoteErrors = 0
  const deadline = started + 960_000
  try {
    while (Date.now() < deadline) {
      if (requestError) throw requestError
      const snapshots = await db`select id,state,time_created,time_updated,source_sandbox_id from session_snapshot where session_id=${sid} order by time_created desc`
      fresh = snapshots.find((row) => !oldIDs.has(row.id)) ?? null
      operation = (await db`select id,state,attempts,error,time_created,time_updated from snapshot_operation where session_id=${sid} and sandbox_id=${source.id} order by time_created desc limit 1`)[0] ?? null
      if (fresh && fresh.state === "ready" && pgReadyObservedMs === null) pgReadyObservedMs = Date.now() - started
      if (fresh && remoteReadyObservedMs === null) {
        try {
          const response = await fetch(`${platform}/snapshots/${fresh.id}`, { headers: platformHeaders, signal: AbortSignal.timeout(5000) })
          assert(response.ok, `平台只读快照查询 HTTP ${response.status}`)
          const item = await response.json()
          remote = { id: item.id, status: item.status, createdAt: item.createdAt, updatedAt: item.updatedAt }
          if (item.status?.state === "Ready") remoteReadyObservedMs = Date.now() - started
          assert(item.status?.state !== "Failed", `平台快照 Failed：${label}`)
        } catch (error) {
          remoteErrors++
          if (remote?.status?.state === "Failed") throw error
        }
      }
      assert(operation?.state !== "failed", `操作失败：${label} ${operation?.error}`)
      assert(fresh?.state !== "failed", `PG 快照失败：${label}`)
      const sandbox = (await db`select id,state from sandbox where session_id=${sid}`)[0]
      if (operation?.state === "done" && sandbox?.state === "destroyed" && requestDone) {
        assert(Number(operation.attempts) === 1, `受重试污染：${label} attempts=${operation.attempts}`)
        assert(reuse ? !fresh && before.some((row) => row.state === "ready" || row.state === "stale") : fresh?.state === "ready", `创建/复用不符合预期：${label}`)
        if (!reuse) assert(remoteReadyObservedMs !== null, `没有观测到平台 Ready：${label}`)
        const result = {
          round, sid, label, reuse, sourceSandboxID: source.id,
          snapshotID: fresh?.id ?? snapshots[0]?.id,
          endToEndMs: Date.now() - started, requestMs,
          pgReadyObservedMs, remoteReadyObservedMs, remoteErrors,
          pgCreateToReadyMs: fresh ? Number(fresh.time_updated) - Number(fresh.time_created) : null,
          operation, snapshot: fresh, remote,
        }
        report.samples.push(result)
        save()
        log("sample", { round, label, reuse, endToEndMs: result.endToEndMs, pgCreateToReadyMs: result.pgCreateToReadyMs, remoteReadyObservedMs, attempts: operation.attempts })
        return result
      }
      await sleep(1000)
    }
    throw new Error(`快照完成超时：${label}`)
  } finally { await request }
}

const stats = "du -sk /workspace; find /workspace -type f | wc -l"
const verify = "sha256sum -c /workspace/.probe.sha256 >/dev/null"
const fingerprint = "find /workspace -type f ! -name .probe.sha256 -exec sha256sum {} + | LC_ALL=C sort > /workspace/.probe.sha256"

try {
  assert(Number(report.config.waitSec) === 900, "有效 SNAPSHOT_WAIT_SEC 必须为 900")
  assert(Number.isInteger(rounds) && rounds > 0 && rounds <= 5, "轮数必须为 1–5")
  await api("GET", "/api/info")
  log("config", report.config)
  save()
  for (let round = 1; round <= rounds; round++) {
    const created = await api("POST", "/api/session", { sandbox: { cpu: "2", memory: "4Gi", image: report.config.image, persistMode: "snapshot" } })
    const sid = created?.data?.id
    assert(typeof sid === "string", "会话创建响应缺少 id")
    report.sessions.push({ round, sid, cleaned: false })
    save()
    log("session", { round, sid })
    await command(sid, "基线", `printf 'base v1\\n' > a.txt; printf 'base v1\\n' > b.txt; ${fingerprint}; ${stats}`)
    await checkpoint(sid, round, "基线_2文件")
    await command(sid, "恢复并安装依赖", `${verify}; printf '%s' '{"name":"snapshot-probe","private":true,"scripts":{"build":"next build"},"dependencies":{"next":"16.3.8","react":"19.3.0","react-dom":"19.3.0"}}' > package.json; printf 'store-dir=.pnpm-store\\nregistry=https://registry.npmmirror.com/\\n' > .npmrc; pnpm install > /tmp/probe-install.log 2>&1 || { tail -40 /tmp/probe-install.log; exit 1; }; test -f node_modules/next/package.json; ${fingerprint}; ${stats}`)
    await checkpoint(sid, round, "依赖安装_约344MB")
    for (let edit = 1; edit <= 3; edit++) {
      await command(sid, `恢复并小改${edit}`, `${verify}; printf '\\n// small edit round ${edit}\\n' >> a.txt; ${fingerprint}; ${stats}`)
      await checkpoint(sid, round, `小改${edit}`)
    }
    await command(sid, "恢复并构建", `${verify}; mkdir -p app; printf '%s' 'export default function Layout({children}) {return <html><body>{children}</body></html>}' > app/layout.js; printf '%s' 'export default function Page() {return <main>Snapshot latency probe</main>}' > app/page.js; pnpm build > /tmp/probe-build.log 2>&1 || { tail -60 /tmp/probe-build.log; exit 1; }; test -f .next/BUILD_ID; ${fingerprint}; ${stats}`)
    await checkpoint(sid, round, "构建产物")
    await command(sid, "恢复校验_无变化", `${verify}; test -f .next/BUILD_ID; ${stats}`)
    await checkpoint(sid, round, "无变化_CLEAN", true)
    // 保留完整测量结果后，仅通过 API 清理本轮会话。
    await api("DELETE", `/api/session/${sid}`)
    report.sessions.at(-1).cleaned = true
    save()
    log("round_pass", { round })
  }
  report.passed = true
  log("PASS", { samples: report.samples.length })
} catch (error) {
  report.error = String(error)
  process.exitCode = 1
  log("FAIL", { error: String(error), retainedSessions: report.sessions.filter((item) => !item.cleaned).map((item) => item.sid) })
} finally {
  report.finishedAt = new Date().toISOString()
  save()
  await db.close()
}
