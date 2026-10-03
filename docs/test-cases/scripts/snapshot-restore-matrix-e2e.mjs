// 当前SaaS/OpenSandbox恢复性能矩阵；仅创建并清理本脚本的专用会话。
import { command, report, db, save, api, inspect, snapshot } from "./snapshot-layer-confirmation-e2e.mjs"

const rounds = Number(process.env.PROBE_ROUNDS ?? 3)
const assert = (ok, message) => { if (!ok) throw new Error(message) }
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`
const log = (step, data) => console.log(JSON.stringify({ step, ...data }))
const fingerprint = "find /workspace -type f ! -name .restore.sha256 -exec sha256sum {} + | LC_ALL=C sort > /workspace/.restore.sha256; sha256sum /home/sandbox/restore-marker.txt /resources/restore-marker.txt >> /workspace/.restore.sha256"
const verify = "sha256sum -c /workspace/.restore.sha256 >/dev/null; test -L /workspace/restore-link; test \"$(readlink /workspace/restore-link)\" = '/home/sandbox/restore-marker.txt'; test \"$(stat -c %a /workspace/restore-executable)\" = 750"
const mounts = String.raw`const fs=require('node:fs');try{const mounts=fs.readFileSync('/proc/self/mountinfo','utf8').trim().split('\n').map(l=>{const [a,b]=l.split(' - ');const p=a.split(' ');return {id:p[0],path:p[4],type:b.split(' ')[0]}});const root=mounts.find(m=>m.path==='/');const paths=['/workspace','/resources','/home/sandbox','/home/sandbox/.cache','/home/sandbox/.config','/home/sandbox/.local','/home/sandbox/tmp'];const selected=paths.map(path=>({path,mount:mounts.filter(m=>m.path==='/'||path===m.path||path.startsWith(m.path+'/')).sort((a,b)=>b.path.length-a.path.length)[0]}));if(!root||root.type!=='overlay'||selected.some(x=>x.mount?.id!==root.id))throw new Error('非互斥snapshot rootfs挂载');console.log(JSON.stringify({root,selected}));}catch(e){console.error(String(e));process.exit(1)}`

report.sessions = []
report.restores = []
report.preflights = []
report.timings = []
report.scope = "OpenSandbox snapshot互斥；shell/API/PG，非AI/code-mode验收；远端节点与缓存不可控；计时用performance.now；命令包含SSE往返和最多约100ms结束事件采样"
async function timedCommand(sid, label, script) {
  const start = performance.now()
  const result = await command(sid, script)
  const sample = { sid, label, elapsedMs: performance.now() - start, ...result }
  report.timings.push(sample); save()
  return sample
}
async function preflight(sid, label) {
  const row = (await db`select sandbox from session_v2 where id=${sid}`)[0]
  const config = typeof row?.sandbox === "string" ? JSON.parse(row.sandbox) : row?.sandbox
  assert(config?.persistMode === "snapshot", "PG不是snapshot模式")
  const result = await command(sid, `node -e ${quote(mounts)}; pnpm --version; registry=$(pnpm config get registry); case "$registry" in https://registry.npmmirror.com|https://registry.npmmirror.com/) ;; *) echo "错误registry=$registry"; exit 1 ;; esac; echo "REGISTRY=$registry"`)
  report.preflights.push({ sid, label, persistMode: config.persistMode, ...result }); save()
}
async function boot(sid) {
  const start = performance.now()
  const result = await api("POST", `/api/experimental/session/${sid}/keep-alive`, { enabled: true, boot: true })
  const elapsedMs = performance.now() - start
  assert(typeof result?.sandboxId === "string", "boot返回空沙箱ID，可能吞掉恢复错误")
  const row = (await db`select id,state from sandbox where session_id=${sid}`)[0]
  assert(row?.id === result.sandboxId && row.state === "running", "boot返回与PG running不符")
  return { elapsedMs, id: row.id }
}
async function restore(sid, round, label, requestedSnapshotID, build = false) {
  const old = (await db`select id from sandbox where session_id=${sid}`)[0].id
  const killedAt = performance.now()
  const killed = await api("POST", `/api/session/${sid}/kill-sandbox`)
  const destroyMs = performance.now() - killedAt
  assert(killed?.destroyed === true, "kill未确认销毁")
  assert((await db`select state from sandbox where session_id=${sid}`)[0]?.state === "destroyed", "PG未destroyed")
  const ready = await db`select id,state,source_sandbox_id from session_snapshot where session_id=${sid} and scope='session' and state in ('ready','stale') order by time_created desc limit 1`
  assert(ready.length === 1, "销毁后缺可恢复快照")
  const selected = ready[0]
  const startedAt = new Date().toISOString()
  const totalStart = performance.now()
  const restored = await boot(sid)
  assert(restored.id !== old, "恢复未切换代际")
  const first = await timedCommand(sid, `${label}:首条命令`, "printf RESTORE_EXEC_READY")
  const requestToFirstExecMs = performance.now() - totalStart
  // 平台查询和PG核验在首次exec之后，不进入恢复或首命令计时。
  await inspect(restored.id, `${round}:${label}`)
  assert(report.sandboxes.at(-1).snapshotId === selected.id, "平台未使用PG最新可恢复快照")
  const sample = { sid, round, label, startedAt, requestedSnapshotID, selectedSnapshotID: selected.id,
    snapshotReused: requestedSnapshotID === selected.id, oldSandboxID: old, restoredSandboxID: restored.id,
    destroyMs, bootMs: restored.elapsedMs, firstExecMs: first.elapsedMs, requestToFirstExecMs,
    snapshot: selected, verified: false }
  report.restores.push(sample); save(); log("restore_started", sample)
  const checked = await timedCommand(sid, `${label}:文件验证`, `${verify}; du -sk /workspace; find /workspace -type f | wc -l`)
  sample.verifyMs = checked.elapsedMs
  await preflight(sid, `${round}:${label}`)
  if (build) {
    const built = await timedCommand(sid, `${label}:恢复后构建`, "NEXT_TELEMETRY_DISABLED=1 pnpm build >/tmp/restore-build.log 2>&1 || { tail -60 /tmp/restore-build.log; exit 1; }; test -f .next/BUILD_ID")
    sample.buildMs = built.elapsedMs
  }
  sample.verified = true; save(); log("restore_pass", sample)
  return restored.id
}
async function stage(sid, round, label, script, build = false) {
  await timedCommand(sid, `${label}:准备`, `${script}; ${fingerprint}; du -sk /workspace; find /workspace -type f | wc -l`)
  const started = performance.now()
  const id = await snapshot(sid, `${round}:${label}`)
  report.timings.push({ sid, label: `${label}:创建快照`, elapsedMs: performance.now() - started }); save()
  await restore(sid, round, label, id, build)
}

try {
  assert(Number.isInteger(rounds) && rounds >= 1 && rounds <= 3, "轮数必须1–3")
  assert(process.env.OPENCODE_SANDBOX_SNAPSHOT_WAIT_SEC === "900", "wait必须900")
  await api("GET", "/api/info")
  for (let round = 1; round <= rounds; round++) {
    const response = await api("POST", "/api/session", { sandbox: { cpu: "2", memory: "4Gi", image: process.env.OPENCODE_SANDBOX_IMAGE, persistMode: "snapshot" } })
    const sid = response?.data?.id
    assert(typeof sid === "string", "创建会话缺ID")
    report.sessions.push({ sid, round, cleaned: false }); save(); log("session", { sid, round })
    const initial = await boot(sid)
    report.timings.push({ sid, label: "初次boot基线_不含恢复", elapsedMs: initial.elapsedMs }); save()
    await preflight(sid, `${round}:初次boot`)
    await stage(sid, round, "最小工作区", "mkdir -p /resources; printf home > /home/sandbox/restore-marker.txt; printf resources > /resources/restore-marker.txt; printf '#!/bin/sh\\nexit 0\\n' > restore-executable; chmod 750 restore-executable; ln -s /home/sandbox/restore-marker.txt restore-link")
    const pkg = { name: "restore-matrix-probe", private: true, scripts: { build: "next build" }, dependencies: { next: "16.3.8", react: "19.3.0", "react-dom": "19.3.0" } }
    await stage(sid, round, "仅Next源码", `printf '%s' ${quote(JSON.stringify(pkg))} > package.json; printf 'store-dir=.pnpm-store\\nregistry=https://registry.npmmirror.com/\\n' > .npmrc; mkdir -p app; printf '%s' 'export default function Layout({children}) {return <html><body>{children}</body></html>}' > app/layout.js; printf '%s' 'export default function Page() {return <main>Restore 0</main>}' > app/page.js`)
    await stage(sid, round, "安装依赖", "pnpm install >/tmp/restore-install.log 2>&1 || { tail -60 /tmp/restore-install.log; exit 1; }; test -f node_modules/next/package.json", true)
    // 上一恢复后的build已经生成产物，本阶段单独保存它们。
    await stage(sid, round, "含构建产物", "test -f .next/BUILD_ID", true)
    await stage(sid, round, "多代快照小改", "printf '%s' 'export default function Page() {return <main>Restore multi generation</main>}' > app/page.js", true)
    await stage(sid, round, "额外64MiB不可压缩文件", "head -c 67108864 /dev/urandom > restore-payload.bin")
    // 不改变文件内容重复恢复，核对是否复用了同一个Ready快照。
    await restore(sid, round, "重复恢复64MiB快照", report.snapshots.at(-1).id)
    const operations = await db`select kind,state,attempts from snapshot_operation where session_id=${sid}`
    assert(operations.every(x => x.state === "done" && Number(x.attempts) === 1), "销毁队列出现失败或重试")
    report.sessions.at(-1).operations = operations
    await api("DELETE", `/api/session/${sid}`)
    assert(Number((await db`select count(*)::int as n from session_v2 where id=${sid}`)[0].n) === 0, "PG会话未清理")
    report.sessions.at(-1).cleaned = true; save(); log("round_pass", { round })
  }
  report.passed = true; log("PASS", { restores: report.restores.length })
} catch (e) {
  report.error = String(e); process.exitCode = 1
  log("FAIL", { error: String(e), retainedSessions: report.sessions.filter(x => !x.cleaned) })
} finally {
  report.finishedAt = new Date().toISOString(); save(); await db.close()
}
