#!/usr/bin/env node
// Session PVC 模式 V2 用例（T38.1–T38.27）
// 文档：docs/test-cases/sandbox/store/pvc/session-pvc-mode.md（V2 API 适配版）
//
// 用法：
//   BASE=http://localhost:14096 AUTH=opencode:<password> \
//   PG_URL=postgresql://local@127.0.0.1:5432/opencode-v2-up \
//   node docs/test-cases/scripts/session-pvc-mode-v2.mjs
//
// 前置：SaaS 容器 OPENCODE_SANDBOX_VOLUME_TYPE=pvc，PG 与服务同库。
// 语义映射（旧 → V2）：
//   POST /session                     → POST /api/session（响应 {data}）
//   POST /session/:id/exec            → POST /api/session/:id/shell + log 轮询 shell.ended
//   POST /session/:id/fork            → POST /api/session/:id/fork
//   GET /path?sessionID=              → GET /api/session/:id → data.location.directory
//   GET /vcs/diff?sessionID=          → GET /api/session/:id/vcs/diff（session 路径参数，沙箱代理执行）

import { spawnSync } from "node:child_process"

const BASE = process.env.BASE ?? "http://localhost:14096"
const AUTH = process.env.AUTH ?? "opencode:pvc-e2e-test"
const PG_URL = process.env.PG_URL ?? "postgresql://local@127.0.0.1:5432/opencode-v2-up"
const HEADERS = { "Content-Type": "application/json", Authorization: "Basic " + Buffer.from(AUTH).toString("base64") }

const results = []
const record = (id, name, pass, detail = "") => {
  results.push({ id, pass })
  console.log(`${pass ? "✅" : "❌"} ${id}: ${pass ? "PASS" : "FAIL"} — ${name}${detail ? ` | ${detail}` : ""}`)
}

async function api(method, path, body) {
  const res = await fetch(BASE + path, { method, headers: HEADERS, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : undefined }
}

const createSession = async (body) => (await api("POST", "/api/session", body)).body?.data

/** 读取 session log（SSE），返回 after 之后的事件与最大 seq。 */
async function readLog(sessionID, after) {
  const res = await fetch(`${BASE}/api/experimental/session/${sessionID}/log?after=${after}`, { headers: HEADERS })
  if (!res.ok) throw new Error(`log HTTP ${res.status}`)
  const text = await res.text()
  const events = []
  let maxSeq = after
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue
    try {
      const event = JSON.parse(line.slice(5).trim())
      if (typeof event === "string" || !event || !event.type) continue
      if (String(event.type).includes("synced")) continue
      events.push(event)
      const seq = event.durable?.seq
      if (typeof seq === "number" && seq > maxSeq) maxSeq = seq
    } catch {}
  }
  return { events, maxSeq }
}

/** 执行 shell 命令并等待完成，返回合并输出。 */
async function shell(sessionID, command, timeoutMs = 120_000) {
  const { maxSeq } = await readLog(sessionID, 0).catch(() => ({ maxSeq: 0 }))
  const post = await api("POST", `/api/session/${sessionID}/shell`, { command })
  if (post.status !== 204) throw new Error(`shell HTTP ${post.status}: ${JSON.stringify(post.body)}`)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500))
    const { events, maxSeq: next } = await readLog(sessionID, maxSeq).catch(() => ({ events: [], maxSeq }))
    for (const event of events) {
      if (event.type !== "session.shell.ended") continue
      const shell = event.data?.shell ?? {}
      if (shell.command === command && shell.status !== "running") {
        return { output: event.data?.output?.output ?? "", exit: shell.exit, status: shell.status }
      }
    }
    if (next > maxSeq) maxSeq = next === undefined ? maxSeq : maxSeq
  }
  throw new Error(`shell timed out after ${timeoutMs}ms: ${command.slice(0, 60)}`)
}

function psql(sql) {
  const run = spawnSync("psql", [PG_URL, "-tAc", sql], { encoding: "utf8", timeout: 15_000 })
  if (run.status !== 0) throw new Error(`psql failed: ${run.stderr}`)
  return run.stdout.trim()
}

const ts = () => Date.now().toString(36)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- 一、创建会话 — 输入校验 ----------

async function t38_1() {
  const s = await createSession({})
  const pg = psql(`SELECT coalesce(pvc_mode,'NULL'), coalesce(app_id,'NULL'), directory FROM session_v2 WHERE id='${s.id}'`)
  const pass = s.pvcMode === undefined && s.appId === undefined && s.location.directory === "/workspace" &&
    pg === "NULL|NULL|/workspace"
  record("T38.1", "默认行为不变 dir=/workspace", pass, `pg=[${pg}]`)
}

async function t38_2() {
  const s = await createSession({ pvcMode: "session" })
  record("T38.2", "显式 pvcMode=session", s.pvcMode === "session" && s.location.directory === "/workspace")
}

async function t38_3() {
  const APP_ID = "test-app-" + ts()
  const s = await createSession({ pvcMode: "app", appId: APP_ID })
  const pg = psql(`SELECT coalesce(pvc_mode,'NULL'), coalesce(app_id,'NULL'), directory FROM session_v2 WHERE id='${s.id}'`)
  const pass = s.pvcMode === "app" && s.appId === APP_ID && s.location.directory === "/workspace" &&
    pg === `app|${APP_ID}|/workspace`
  record("T38.3", "app 模式创建 + dir 不暴露 worktree", pass, `pg=[${pg}]`)
}

async function t38_4() {
  const res = await api("POST", "/api/session", { pvcMode: "app" })
  record("T38.4", "app 缺 appId → 400", res.status === 400, `status=${res.status}`)
}

async function t38_5() {
  const res = await api("POST", "/api/session", { pvcMode: "app", appId: "   " })
  record("T38.5", "app 空白 appId → 400", res.status === 400, `status=${res.status}`)
}

async function t38_6() {
  const res = await api("POST", "/api/session", { pvcMode: "global" })
  record("T38.6", "非法 pvcMode → 400（schema 校验）", res.status === 400, `status=${res.status}`)
}

async function t38_7() {
  const malicious = ["../../sessions/xxx", "apps/../sessions/xxx", "a/b", "a;b", "a rm -rf", "a$HOME"]
  const codes = []
  for (const appId of malicious) {
    const res = await api("POST", "/api/session", { pvcMode: "app", appId })
    codes.push(`${appId}→${res.status}`)
  }
  const allBlocked = codes.every((c) => c.endsWith("400"))
  record("T38.7", "appId 路径穿越全部拒绝", allBlocked, codes.join(", "))
}

async function t38_8() {
  const res = await api("POST", "/api/session", { pvcMode: "app", appId: "a".repeat(129) })
  record("T38.8", "appId 超长(129) → 400", res.status === 400, `status=${res.status}`)
}

async function t38_9() {
  const valid = ["my-app", "my_app", "my.app", "app-123", "A.B.C-1_2", "a"]
  const rows = []
  let allOk = true
  for (const appId of valid) {
    const res = await api("POST", "/api/session", { pvcMode: "app", appId })
    const stored = res.body?.data?.appId
    rows.push(`${appId}→${res.status}/${stored}`)
    if (res.status !== 200 || stored !== appId) allOk = false
  }
  record("T38.9", "appId 合法边界字符全部通过", allOk, rows.join(", "))
}

// ---------- 二、PVC 共享与隔离 ----------

async function t38_10() {
  const APP_ID = "share-" + ts()
  const a = await createSession({ pvcMode: "app", appId: APP_ID })
  const b = await createSession({ pvcMode: "app", appId: APP_ID })
  await shell(a.id, "mkdir -p /workspace/repo && echo shared-content > /workspace/repo/shared-file.txt")
  const read = await shell(b.id, "cat /workspace/repo/shared-file.txt 2>&1")
  const pass = (read.output ?? "").includes("shared-content")
  record("T38.10", "同 appId 不同会话共享 PVC", pass, `B读取=[${(read.output ?? "").trim().slice(0, 40)}]`)
}

async function t38_11() {
  const T = ts()
  const a = await createSession({ pvcMode: "app", appId: "iso-a-" + T })
  const b = await createSession({ pvcMode: "app", appId: "iso-b-" + T })
  await shell(a.id, "echo from-a > /workspace/repo/iso-a.txt")
  const read = await shell(b.id, "cat /workspace/repo/iso-a.txt 2>&1")
  const pass = (read.output ?? "").includes("No such file")
  record("T38.11", "不同 appId PVC 隔离", pass, `B读取=[${(read.output ?? "").trim().slice(0, 40)}]`)
}

async function t38_12() {
  const T = ts()
  const s = await createSession({ pvcMode: "session" })
  const a = await createSession({ pvcMode: "app", appId: "cross-" + T })
  await shell(s.id, "mkdir -p /workspace/repo && echo session-data > /workspace/repo/session-only.txt")
  const read = await shell(a.id, "cat /workspace/repo/session-only.txt 2>&1")
  const pass = (read.output ?? "").includes("No such file")
  record("T38.12", "session/app 模式隔离", pass, `app读取=[${(read.output ?? "").trim().slice(0, 40)}]`)
}

// ---------- 三、持久化与继承 ----------

async function t38_18() {
  const APP_ID = "pg-" + ts()
  const s = await createSession({ pvcMode: "app", appId: APP_ID })
  const info = (await api("GET", `/api/session/${s.id}`)).body.data
  const pg = psql(`SELECT coalesce(pvc_mode,'NULL'), coalesce(app_id,'NULL'), directory FROM session_v2 WHERE id='${s.id}'`)
  const pass = info.pvcMode === "app" && info.appId === APP_ID && info.location.directory === "/workspace" &&
    pg === `app|${APP_ID}|/workspace`
  record("T38.18", "pvcMode/appId PG 持久化（API+直查）", pass, `pg=[${pg}]`)
}

async function t38_19() {
  const APP_ID = "child-" + ts()
  const parent = await createSession({ pvcMode: "app", appId: APP_ID })
  // fork 需要至少一条已投影消息：先跑一条 shell 作为 boundary
  await shell(parent.id, "mkdir -p /workspace/repo && echo parent-data > /workspace/repo/parent.txt")
  const fork = (await api("POST", `/api/session/${parent.id}/fork`, {})).body.data
  await sleep(3000)
  const read = await shell(fork.id, "cat /workspace/repo/parent.txt 2>&1")
  const pg = psql(`SELECT coalesce(pvc_mode,'NULL'), coalesce(app_id,'NULL') FROM session_v2 WHERE id='${fork.id}'`)
  const metaOk = fork.pvcMode === "app" && fork.appId === APP_ID
  const dataOk = (read.output ?? "").includes("parent-data")
  const pass = metaOk && dataOk && pg === `app|${APP_ID}`
  record("T38.19", "fork 继承 pvcMode/appId + 数据共享", pass, `meta=${metaOk} data=${dataOk} fork读=[${(read.output ?? "").trim().slice(0, 30)}] pg=[${pg}]`)
}

async function t38_20() {
  const APP_ID = "task-" + ts()
  const parent = await createSession({ pvcMode: "app", appId: APP_ID })
  await shell(parent.id, "mkdir -p /workspace/repo && echo parent-data > /workspace/repo/parent.txt")
  const child = await createSession({ parentID: parent.id })
  await sleep(2000)
  const read = await shell(child.id, "cat /workspace/repo/parent.txt 2>&1")
  const pg = psql(`SELECT coalesce(parent_id,'NULL'), coalesce(pvc_mode,'NULL'), coalesce(app_id,'NULL') FROM session_v2 WHERE id='${child.id}'`)
  const dataOk = (read.output ?? "").includes("parent-data")
  const pass = child.parentID === parent.id && child.pvcMode === "app" && child.appId === APP_ID && dataOk &&
    pg === `${parent.id}|app|${APP_ID}`
  record("T38.20", "子任务会话创建时继承 + 共享 PVC", pass, `child读=[${(read.output ?? "").trim().slice(0, 30)}] pg=[${pg}]`)
}

async function t38_21() {
  const parentS = await createSession({ pvcMode: "session" })
  await shell(parentS.id, "echo boundary")
  const childS = await createSession({ parentID: parentS.id })
  const pass1 = childS.pvcMode === undefined && childS.appId === undefined
  const forkS = (await api("POST", `/api/session/${parentS.id}/fork`, {})).body.data
  const pass2 = forkS.pvcMode === undefined && forkS.appId === undefined
  const parentU = await createSession({})
  await shell(parentU.id, "echo boundary")
  const childU = await createSession({ parentID: parentU.id })
  const pass3 = childU.pvcMode === undefined && childU.appId === undefined
  const pg = psql(`SELECT count(*) FROM session_v2 WHERE id IN ('${childS.id}','${forkS.id}','${childU.id}') AND (pvc_mode IS NOT NULL OR app_id IS NOT NULL)`)
  record("T38.21", "session 模式不受 app 逻辑污染", pass1 && pass2 && pass3 && pg === "0",
    `s1=${pass1} s2=${pass2} s3=${pass3} pg污染数=${pg}`)
}

// ---------- 四、真实流程 E2E — worktree 代码写入位置 ----------

/** V2 shell 的 cwd 固定为 /workspace（沙箱内），命令内部自行 cd（与旧 exec workingDirectory 语义差异，见文档）。 */
async function t38_22() {
  const session = await createSession({ pvcMode: "app", appId: "e2e-app-" + ts() })
  const SID = session.id
  const wtPath = `/workspace/worktrees/${SID}`
  // 铺仓库（用 git init 代替 clone agent-browser：断言目标一致——worktree 写入位置，且更快更稳）
  await shell(SID, "git init -q /workspace/repo && cd /workspace/repo && git config user.email test@test.com && git config user.name Test && printf baseline > tracked.txt && git add -A && git commit -qm baseline", 180_000)
  await shell(SID, `cd /workspace/repo && git worktree add -q -b feature/${SID} ${wtPath} HEAD`, 60_000)
  // 模拟外部编排系统改 PG directory 指向 worktree
  psql(`UPDATE session_v2 SET directory='${wtPath}' WHERE id='${SID}'`)
  // API 视角 directory（旧 /path 等价物）
  const info = (await api("GET", `/api/session/${SID}`)).body.data
  // 沙箱内验证写入位置
  const pwd = await shell(SID, `cd ${wtPath} && pwd`)
  const write = await shell(SID, `cd ${wtPath} && echo "test content from e2e" > README.md && git status --short`)
  const mainStatus = await shell(SID, "cd /workspace/repo && git status --short")
  // /api/session/:id/vcs/diff：以该 session 的 directory（worktree）为 cwd 在沙箱内执行
  const apiDiff = await api("GET", `/api/session/${SID}/vcs/diff?mode=working`)
  const apiFiles = (apiDiff.body?.data ?? []).map((d) => d.file).sort()
  const wtTracked = await shell(SID, `cd ${wtPath} && git diff HEAD --name-only`)
  const wtUntracked = await shell(SID, `cd ${wtPath} && git ls-files --others --exclude-standard`)
  const wtFiles = ((wtTracked.output ?? "") + "\n" + (wtUntracked.output ?? "")).split("\n").map((s) => s.trim()).filter(Boolean).sort()
  const pass =
    info.location.directory === wtPath &&
    (pwd.output ?? "").trim() === wtPath &&
    (write.output ?? "").includes("README.md") &&
    (mainStatus.output ?? "").trim() === "" &&
    JSON.stringify(wtFiles) === JSON.stringify(["README.md"]) &&
    apiDiff.status === 200 &&
    JSON.stringify(apiFiles) === JSON.stringify(["README.md"])
  record("T38.22", "app 模式 worktree 写入位置正确", pass,
    `dir=${info.location.directory} pwd=${(pwd.output ?? "").trim()} wtStatus=[${(write.output ?? "").trim()}] mainRepo=[${(mainStatus.output ?? "").trim() || "clean"}] apiDiff=[${apiFiles.join(",")}]`)
}

async function t38_23() {
  const session = await createSession({})
  const SID = session.id
  const wtPath = `/workspace/worktrees/${SID}`
  await shell(SID, "git init -q /workspace/repo && cd /workspace/repo && git config user.email test@test.com && git config user.name Test && printf baseline > tracked.txt && git add -A && git commit -qm baseline", 180_000)
  await shell(SID, `cd /workspace/repo && git worktree add -q -b feature/session-${SID.slice(-8)} ${wtPath} HEAD`, 60_000)
  psql(`UPDATE session_v2 SET directory='${wtPath}' WHERE id='${SID}'`)
  const info = (await api("GET", `/api/session/${SID}`)).body.data
  const pwd = await shell(SID, `cd ${wtPath} && pwd`)
  const write = await shell(SID, `cd ${wtPath} && echo "session-mode test" > README.md && git status --short`)
  const mainStatus = await shell(SID, "cd /workspace/repo && git status --short")
  const pass =
    info.location.directory === wtPath &&
    (pwd.output ?? "").trim() === wtPath &&
    (write.output ?? "").includes("README.md") &&
    (mainStatus.output ?? "").trim() === ""
  record("T38.23", "session 模式 worktree 写入位置正确", pass,
    `dir=${info.location.directory} pwd=${(pwd.output ?? "").trim()} wtStatus=[${(write.output ?? "").trim()}] mainRepo=[${(mainStatus.output ?? "").trim() || "clean"}]`)
}

/** /api/session/:id/vcs/diff 在会话沙箱执行（V2 沙箱代理，2026-09-24 补齐）。 */
async function t38_24() {
  const session = await createSession({ pvcMode: "session" })
  await shell(session.id, "cd /workspace && git init -q && git config user.email test@test.com && git config user.name Test && printf baseline > tracked.txt && git add -A && git commit -qm baseline && printf session-changed > tracked.txt && printf session-new > untracked.txt", 180_000)
  const res = await api("GET", `/api/session/${session.id}/vcs/diff?mode=working`)
  const diffs = res.body?.data ?? []
  const files = diffs.map((d) => d.file).sort()
  const tracked = diffs.find((d) => d.file === "tracked.txt")
  const untracked = diffs.find((d) => d.file === "untracked.txt")
  const pass =
    res.status === 200 &&
    JSON.stringify(files) === JSON.stringify(["tracked.txt", "untracked.txt"]) &&
    tracked?.status === "modified" && (tracked.patch ?? "").includes("+session-changed") &&
    untracked?.status === "added" && (untracked.patch ?? "").includes("+session-new")
  record("T38.24", "session 模式 vcs/diff(working) 沙箱代理读取 /workspace", pass,
    `status=${res.status} files=[${files.join(",")}] tracked=modified/${(tracked?.patch ?? "").includes("+session-changed")} untracked=added/${(untracked?.patch ?? "").includes("+session-new")}`)
}

async function t38_25() {
  const appId = "vcs-diff-" + ts()
  const session = await createSession({ pvcMode: "app", appId })
  const wtPath = `/workspace/worktrees/${session.id}`
  await shell(session.id, "git init -q /workspace/repo && cd /workspace/repo && git config user.email test@test.com && git config user.name Test && printf baseline > tracked.txt && git add tracked.txt && git commit -qm baseline", 180_000)
  await shell(session.id, `cd /workspace/repo && git worktree add -q -b test-${session.id.slice(-8)} ${wtPath} HEAD`, 60_000)
  psql(`UPDATE session_v2 SET directory='${wtPath}' WHERE id='${session.id}'`)
  await shell(session.id, `cd ${wtPath} && printf app-changed > tracked.txt && printf app-new > worktree-only.txt && printf main-pollution > /workspace/repo/main-only.txt`)
  // 不传 directory：session 路由固定用该 session 的 directory（worktree），不读共享主仓库
  const res = await api("GET", `/api/session/${session.id}/vcs/diff?mode=working`)
  const diffs = res.body?.data ?? []
  const files = diffs.map((d) => d.file).sort()
  const tracked = diffs.find((d) => d.file === "tracked.txt")
  const added = diffs.find((d) => d.file === "worktree-only.txt")
  const pass =
    res.status === 200 &&
    JSON.stringify(files) === JSON.stringify(["tracked.txt", "worktree-only.txt"]) &&
    !files.includes("main-only.txt") &&
    tracked?.status === "modified" && (tracked.patch ?? "").includes("+app-changed") &&
    added?.status === "added" && (added.patch ?? "").includes("+app-new")
  record("T38.25", "app 模式 vcs/diff 以 session.directory(worktree) 为准", pass,
    `status=${res.status} files=[${files.join(",")}] main-only排除=${!files.includes("main-only.txt")} +app-changed=${(tracked?.patch ?? "").includes("+app-changed")} +app-new=${(added?.patch ?? "").includes("+app-new")}`)
}

// ---------- 四（续）、边界行为（2026-10-02 新增） ----------

// 孤儿 appId：只传 appId 不传 pvcMode。创建成功，app_id 落库，但卷前缀仍按
// sessions/{sessionID}，同 appId 的 app 会话读不到它的文件（不进入 app 空间）。
async function t38_26() {
  const APP_ID = "orphan-" + ts()
  const orphan = await createSession({ appId: APP_ID })
  const app = await createSession({ pvcMode: "app", appId: APP_ID })
  const pg = psql(`SELECT coalesce(pvc_mode,'NULL'), coalesce(app_id,'NULL') FROM session_v2 WHERE id='${orphan.id}'`)
  await shell(orphan.id, "mkdir -p /workspace/repo && echo orphan-data > /workspace/repo/orphan.txt")
  const read = await shell(app.id, "cat /workspace/repo/orphan.txt 2>&1")
  const metaOk = orphan.pvcMode === undefined && orphan.appId === APP_ID
  const isolated = (read.output ?? "").includes("No such file")
  const pass = metaOk && isolated && pg === `NULL|${APP_ID}`
  record("T38.26", "孤儿 appId 按会话 ID 隔离", pass,
    `meta=${metaOk} isolated=${isolated} pg=[${pg}] app读取=[${(read.output ?? "").trim().slice(0, 30)}]`)
}

// V2 沙箱 diff 脚本 context 缺省为 3（V1 为全上下文）。改大文件中间一行，
// patch 只带前后各 3 行上下文：第 2-8 行在、第 1/10 行不在。
async function t38_27() {
  const session = await createSession({ pvcMode: "session" })
  await shell(
    session.id,
    "cd /workspace && git init -q && git config user.email test@test.com && git config user.name Test && seq 1 10 > big.txt && git add -A && git commit -qm baseline && sed -i 's/^5$/changed/' big.txt",
  )
  const res = await api("GET", `/api/session/${session.id}/vcs/diff?mode=working`)
  const row = (res.body?.data ?? []).find((d) => d.file === "big.txt")
  const lines = (row?.patch ?? "").split("\n")
  const contextLine = (n) => lines.includes(` ${n}`)
  const pass =
    res.status === 200 &&
    lines.includes("+changed") &&
    contextLine(2) && contextLine(8) &&
    !contextLine(1) && !contextLine(10)
  record("T38.27", "vcs/diff 默认上下文 3 行", pass,
    `status=${res.status} +changed=${lines.includes("+changed")} ctx2=${contextLine(2)} ctx8=${contextLine(8)} ctx1=${contextLine(1)} ctx10=${contextLine(10)}`)
}

// ---------- 五、沙箱与 PVC 持久化（docs/test-cases/sandbox/store/pvc/sandbox-pvc.md T5.1–T5.5 V2 适配） ----------

async function t5_1_to_5() {
  const session = await createSession({})
  const SID = session.id

  // T5.1 创建沙箱写入文件
  const write = await shell(SID, "echo 12345 > /workspace/pvc-test.txt && cat /workspace/pvc-test.txt")
  const t51 = (write.output ?? "").includes("12345")

  // T5.2 销毁沙箱
  const kill = await api("POST", `/api/session/${SID}/kill-sandbox`)
  const t52 = kill.status === 200 && kill.body?.destroyed === true
  await sleep(3000)

  // T5.3 重建沙箱后文件仍存在（核心 PVC 测试；下次 shell 自动重建沙箱并挂同一 PVC）
  const read = await shell(SID, "cat /workspace/pvc-test.txt")
  const t53 = (read.output ?? "").includes("12345")

  // T5.4 多文件批量持久化
  await shell(SID, "echo A > /workspace/a.txt && echo B > /workspace/b.txt && echo C > /workspace/c.txt")
  const kill4 = await api("POST", `/api/session/${SID}/kill-sandbox`)
  await sleep(3000)
  const batch = await shell(SID, 'for f in a.txt b.txt c.txt; do echo "$f: $(cat /workspace/$f)"; done')
  const out4 = batch.output ?? ""
  const t54 = kill4.body?.destroyed === true && ["a.txt: A", "b.txt: B", "c.txt: C"].every((l) => out4.includes(l))

  // T5.5 目录持久化
  await shell(SID, "mkdir -p /workspace/sub/deep && echo DEEP > /workspace/sub/deep/x.txt")
  await api("POST", `/api/session/${SID}/kill-sandbox`)
  await sleep(3000)
  const deep = await shell(SID, "cat /workspace/sub/deep/x.txt")
  const t55 = (deep.output ?? "").includes("DEEP")

  record("T5.1", "创建沙箱写入文件（stdout 12345）", t51, `stdout=[${(write.output ?? "").trim()}]`)
  record("T5.2", "kill-sandbox 销毁沙箱", t52, `body=${JSON.stringify(kill.body)}`)
  record("T5.3", "重建沙箱后文件仍存在（PVC 跨实例持久化）", t53, `重建后读取=[${(read.output ?? "").trim()}]`)
  record("T5.4", "多文件批量持久化", t54, `重建后=[${out4.replace(/\n/g, " ")}]`)
  record("T5.5", "目录持久化", t55, `重建后读取=[${(deep.output ?? "").trim()}]`)
}

// ---------- main ----------

const cases = [
  ["T38.1", t38_1], ["T38.2", t38_2], ["T38.3", t38_3], ["T38.4", t38_4], ["T38.5", t38_5],
  ["T38.6", t38_6], ["T38.7", t38_7], ["T38.8", t38_8], ["T38.9", t38_9],
  ["T38.10", t38_10], ["T38.11", t38_11], ["T38.12", t38_12],
  ["T38.18", t38_18], ["T38.19", t38_19], ["T38.20", t38_20], ["T38.21", t38_21],
  ["T38.22", t38_22], ["T38.23", t38_23], ["T38.24", t38_24], ["T38.25", t38_25],
  ["T38.26", t38_26], ["T38.27", t38_27],
  ["T5", t5_1_to_5],
]

const only = process.argv[2]
for (const [id, fn] of cases) {
  if (only && !id.startsWith(only)) continue
  try {
    await fn()
  } catch (error) {
    record(id, "执行异常", false, String(error.message ?? error).slice(0, 200))
  }
}

const failed = results.filter((r) => !r.pass)
console.log(`\n===== 汇总: ${results.length - failed.length}/${results.length} PASS =====`)
if (failed.length) {
  console.log("失败用例:", failed.map((r) => r.id).join(", "))
  process.exitCode = 1
}
