// 真实 Next.js 连续开发对照；需与 snapshot-layer-confirmation-e2e.mjs 放在同目录。
import { command, report, db, save, api, inspect } from "./snapshot-layer-confirmation-e2e.mjs"
const rounds = Number(process.env.PROBE_ROUNDS ?? 3)
const assert = (ok, message) => { if (!ok) throw new Error(message) }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (step, data) => console.log(JSON.stringify({ step, ...data }))
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`
const fingerprint = "find /workspace -type f ! -name .probe.sha256 -exec sha256sum {} + | LC_ALL=C sort > /workspace/.probe.sha256"
const verify = "sha256sum -c /workspace/.probe.sha256 >/dev/null"
const stats = "du -sk /workspace; find /workspace -type f | wc -l"
const mountCheck = quote(String.raw`const fs=require("node:fs");try{const mounts=fs.readFileSync("/proc/self/mountinfo","utf8").trim().split("\n").map(line=>{const [left,right]=line.split(" - ");const a=left.split(" ");return {id:a[0],path:a[4],type:right.split(" ")[0]}});const root=mounts.find(x=>x.path==="/");const paths=["/workspace","/resources","/home/sandbox","/home/sandbox/.cache","/home/sandbox/.config","/home/sandbox/.local","/home/sandbox/tmp"];const selected=paths.map(path=>({path,mount:mounts.filter(x=>x.path==="/"||path===x.path||path.startsWith(x.path+"/")).sort((a,b)=>b.path.length-a.path.length)[0]}));if(!root||root.type!=="overlay"||selected.some(x=>x.mount?.id!==root.id))throw new Error("检测到非rootfs持久化挂载，拒绝snapshot测试");console.log(JSON.stringify({root,selected}));}catch(e){console.error(String(e));process.exit(1)}`)
async function preflight(sid, round, phase) {
  const row = (await db`select sandbox from session_v2 where id=${sid}`)[0]
  const config = typeof row?.sandbox === "string" ? JSON.parse(row.sandbox) : row?.sandbox
  assert(config?.persistMode === "snapshot", "PG会话不是snapshot模式")
  const result = await command(sid, `printf 'store-dir=.pnpm-store\\nregistry=https://registry.npmmirror.com/\\n' > .npmrc; registry=$(pnpm config get registry); test "$registry" = 'https://registry.npmmirror.com/'; echo REGISTRY=$registry; pnpm --version; node -e ${mountCheck}`)
  report.preflights.push({ sid, round, phase, persistMode: config.persistMode, ...result }); save()
}
report.sessions = []
report.samples = []
report.preflights = []
report.scope = "shell/API/PG；不是AI或code-mode验收；无OCI层读取权限"

async function checkpoint(sid, round, label, expectedSource) {
  const before = (await db`select id,state from sandbox where session_id=${sid}`)[0]
  assert(before?.id === expectedSource && before?.state === "running", "快照前沙箱代际或状态错误")
  const started = Date.now()
  const response = await api("POST", `/api/session/${sid}/snapshot`)
  const requestMs = Date.now() - started
  const id = response?.data?.snapshotID
  assert(typeof id === "string", "快照响应缺ID")
  const deadline = Date.now() + 960000
  while (Date.now() < deadline) {
    const row = (await db`select id,state,source_sandbox_id,manifest_token from session_snapshot where id=${id}`)[0]
    assert(row?.state !== "failed", `快照失败 ${label}`)
    if (row?.state === "ready") {
      const previous = report.samples.filter((x) => x.sid === sid).at(-1)
      assert(id !== previous?.snapshotID, "显式快照应生成新的快照ID")
      assert(row.source_sandbox_id === expectedSource, "PG快照源错误")
      const after = (await db`select id,state from sandbox where session_id=${sid}`)[0]
      assert(after?.id === expectedSource && after.state === "running", "refresh改变沙箱代际或状态")
      const sample = { sid, round, label, snapshotID: id, sourceSandboxID: expectedSource, endToEndMs: Date.now() - started, requestMs, snapshot: row }
      report.samples.push(sample); save(); log("checkpoint", sample)
      await inspect(expectedSource, label)
      return id
    }
    await sleep(1000)
  }
  throw new Error(`快照超时 ${label}`)
}

try {
  assert(Number.isInteger(rounds) && rounds >= 1 && rounds <= 3, "轮数必须1–3")
  assert(process.env.OPENCODE_SANDBOX_SNAPSHOT_WAIT_SEC === "900", "有效wait必须900")
  await api("GET", "/api/info")
  for (let round = 1; round <= rounds; round++) {
    const created = await api("POST", "/api/session", { sandbox: { cpu: "2", memory: "4Gi", image: process.env.OPENCODE_SANDBOX_IMAGE, persistMode: "snapshot" } })
    const sid = created?.data?.id
    assert(typeof sid === "string", "创建会话缺ID")
    report.sessions.push({ sid, round, cleaned: false }); save(); log("session", { sid, round })
    await preflight(sid, round, "首次创建")
    await command(sid, `printf '%s' ${quote(JSON.stringify({ name: "active-snapshot-probe", private: true, scripts: { build: "next build" }, dependencies: { next: "16.3.8", react: "19.3.0", "react-dom": "19.3.0" } }))} > package.json; printf 'store-dir=.pnpm-store\\nregistry=https://registry.npmmirror.com/\\n' > .npmrc; mkdir -p app; printf '%s' 'export default function Layout({children}) {return <html><body>{children}</body></html>}' > app/layout.js; printf '%s' 'export default function Page() {return <main>Version 0</main>}' > app/page.js; pnpm install >/tmp/active-install.log 2>&1 || { tail -40 /tmp/active-install.log; exit 1; }; test -f node_modules/next/package.json; ${fingerprint}; ${stats}`)
    const original = (await db`select id from sandbox where session_id=${sid}`)[0].id
    await checkpoint(sid, round, "活跃_安装依赖", original)
    for (let edit = 1; edit <= 3; edit++) {
      await command(sid, `${verify}; printf '%s' ${quote(`export default function Page() {return <main>Version ${edit}</main>}`)} > app/page.js; ${fingerprint}; ${stats}`)
      await checkpoint(sid, round, `活跃_小改${edit}`, original)
    }
    await command(sid, `${verify}; NEXT_TELEMETRY_DISABLED=1 pnpm build >/tmp/active-build.log 2>&1 || { tail -60 /tmp/active-build.log; exit 1; }; test -f .next/BUILD_ID; ${fingerprint}; ${stats}`)
    const built = await checkpoint(sid, round, "活跃_构建", original)
    await command(sid, `${verify}; test -f .next/BUILD_ID`)
    // 显式 POST /snapshot 不走队列，且按契约即使无变化也不复用。
    await api("POST", `/api/session/${sid}/kill-sandbox`)
    assert((await db`select state from sandbox where session_id=${sid}`)[0]?.state === "destroyed", "销毁未完成")
    await command(sid, `${verify}; test -f .next/BUILD_ID; grep -q 'Version 3' app/page.js; ${stats}`)
    const restored = (await db`select id from sandbox where session_id=${sid}`)[0].id
    assert(restored !== original, "恢复未更换代际")
    await inspect(restored, "恢复_构建快照")
    assert(report.sandboxes.at(-1).snapshotId === built, "恢复未使用最新构建快照")
    await preflight(sid, round, "恢复构建快照")
    for (let edit = 4; edit <= 6; edit++) {
      await command(sid, `${verify}; printf '%s' ${quote(`export default function Page() {return <main>Version ${edit}</main>}`)} > app/page.js; ${fingerprint}; ${stats}`)
      await checkpoint(sid, round, `恢复_小改${edit - 3}`, restored)
    }
    const last = report.samples.at(-1).snapshotID
    await api("POST", `/api/session/${sid}/kill-sandbox`)
    await command(sid, `${verify}; grep -q 'Version 6' app/page.js; NEXT_TELEMETRY_DISABLED=1 pnpm build >/tmp/active-rebuild.log 2>&1 || { tail -60 /tmp/active-rebuild.log; exit 1; }; test -f .next/BUILD_ID`)
    const final = (await db`select id from sandbox where session_id=${sid}`)[0].id
    await inspect(final, "恢复_最后小改并重构建")
    assert(report.sandboxes.at(-1).snapshotId === last, "最终恢复不是最新快照")
    await preflight(sid, round, "最终恢复")
    await api("DELETE", `/api/session/${sid}`)
    assert(Number((await db`select count(*)::int as n from session_v2 where id=${sid}`)[0].n) === 0, "PG会话未清理")
    report.sessions.at(-1).cleaned = true; save(); log("round_pass", { round })
  }
  report.passed = true; log("PASS", { samples: report.samples.length })
} catch (e) {
  report.error = String(e); process.exitCode = 1; log("FAIL", { error: String(e), retainedSessions: report.sessions.filter((x) => !x.cleaned) })
} finally {
  report.finishedAt = new Date().toISOString(); save(); await db.close()
}
