// 双实例 HTTP + PG + 远端生命周期断言。使用隔离数据库，保留失败用例用于排障。
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"

const A = process.env.BASE_A ?? "http://127.0.0.1:14124"
const B = process.env.BASE_B ?? "http://127.0.0.1:14125"
const PG = process.env.PG_URL ?? "postgresql://local@127.0.0.1:5432/opencode-v2-snapshot-safety-e2e"
const auth = `Basic ${Buffer.from(`opencode:${process.env.API_PASSWORD ?? "local-e2e"}`).toString("base64")}`
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sql = (query) => execFileSync("psql", [PG, "-X", "-At", "-c", query], { encoding: "utf8", timeout: 20000 }).trim()
const check = (condition, label) => {
  console.log(`${condition ? "PASS" : "FAIL"} ${label}`)
  if (!condition) throw new Error(label)
}
const api = async (base, path, method = "GET", body) => {
  const response = await fetch(`${base}${path}`, {
    method, headers: { authorization: auth, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(180000),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status}: ${text.slice(0,300)}`)
  return text ? JSON.parse(text) : null
}
const wait = async (label, probe, timeout = 180000) => {
  const deadline = Date.now() + timeout
  let round = 0
  while (Date.now() < deadline) {
    const value = await probe()
    if (value) return value
    if (round++ % 5 === 0) console.log(`等待 ${label}`)
    await sleep(1000)
  }
  throw new Error(`等待超时: ${label}`)
}
const shell = async (base, sid, command) => {
  const seq = Number(sql(`select coalesce(max(seq),0) from session_message where session_id='${sid}'`))
  await api(base, `/api/session/${sid}/shell`, "POST", { command })
  return wait("shell 完成", () => {
    const text = sql(`select data::text from session_message where session_id='${sid}' and type='shell' and seq>${seq} and data::jsonb->>'status'='exited' order by seq desc limit 1`)
    return text ? JSON.parse(text) : null
  })
}
const textOf = (message) => JSON.stringify(message)
const latest = (sid) => JSON.parse(sql(`select row_to_json(s) from (select * from session_snapshot where session_id='${sid}' order by time_created desc limit 1) s`))
const count = (sid) => Number(sql(`select count(*) from session_snapshot where session_id='${sid}'`))
const ready = (sid) => wait("快照 Ready", () => { const row = latest(sid); return row?.state === "ready" ? row : null })
const running = (id) => {
  try { return execFileSync("docker", ["inspect", `sandbox-${id}`, "--format", "{{.State.Running}}"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === "true" }
  catch { return false }
}

let sid
let success = false
try {
  await wait("实例 A 就绪", () => api(A, "/api/info").catch(() => null))
  await wait("实例 B 就绪", () => api(B, "/api/info").catch(() => null))
  sid = (await api(A, "/api/session", "POST", {
    model: { providerID: "Yd-DeepSeek", id: "deepseek-v4-flash" },
    sandbox: { cpu: "1", memory: "2Gi", persistMode: "snapshot" },
  })).data.id
  console.log(`本轮会话 ${sid}`)
  await shell(A, sid, "printf v1 > /workspace/safety.txt")
  // 先初始化两个 Location 服务图和连接；本断言验证服务层并发创建，
  // 不把新实例冷初始化的等待时间误当成两个 startSnapshot 的重叠。
  await shell(B, sid, "echo replica-ready")
  const responses = await Promise.all([
    api(A, `/api/session/${sid}/snapshot`, "POST"),
    api(B, `/api/session/${sid}/snapshot`, "POST"),
  ])
  check(!!responses[0].data?.snapshotID && responses[0].data.snapshotID === responses[1].data?.snapshotID, "双实例创建收敛到同一快照 ID")
  const first = await ready(sid)
  check(count(sid) === 1 && !!first.manifest_token, "PG 仅一条快照，带 manifest 身份")
  const source = sql(`select id from sandbox where session_id='${sid}'`)
  await api(A, `/api/session/${sid}/kill-sandbox`, "POST", {})
  check(sql(`select state from sandbox where session_id='${sid}'`) === "destroyed" && !running(source), "快照成功后行终态与远端真实销毁一致")
  check(count(sid) === 1, "无变化销毁复用快照")
  check(textOf(await shell(B, sid, "cat /workspace/safety.txt")).includes("v1"), "跨实例恢复保留代码")

  // 模拟失败的新尝试已改写本地基线；不能拿它证明旧快照覆盖新代码。
  const token = randomUUID()
  await shell(B, sid, `printf v2 > /workspace/safety.txt; printf '${token}' > /var/tmp/.opencode-snapshot-token; touch /var/tmp/.opencode-snapshot-marker; { find /workspace -printf '%y %m %s %p %l\\n'; find /workspace -type f -exec sha256sum {} +; } | LC_ALL=C sort > /var/tmp/.opencode-snapshot-manifest`)
  await api(A, `/api/session/${sid}/kill-sandbox`, "POST", {})
  check(count(sid) === 2, "失败尝试的 manifest 不会让旧快照误判 CLEAN")
  check(sql(`select state from session_snapshot where id='${first.id}'`) === "stale", "新快照 Ready 后旧恢复点仍保留")
  check(textOf(await shell(B, sid, "cat /workspace/safety.txt")).includes("v2"), "新代码通过新快照恢复")

  await api(B, `/api/session/${sid}/kill-sandbox`, "POST", {})
  const restore = latest(sid)
  sql(`update session_snapshot set schema_version=999 where id='${restore.id}'`)
  const blocked = await shell(A, sid, "echo COLD_START_MUST_NOT_RUN")
  check(!textOf(blocked.output).includes("COLD_START_MUST_NOT_RUN"), "不兼容快照不自动执行冷启动命令")
  check(sql(`select count(*) from sandbox where session_id='${sid}' and state='running'`) === "0", "恢复失败未落库空沙箱")
  check(["ready", "stale"].includes(latest(sid).state), "恢复失败仍保留可重试的快照记录")
  sql(`update session_snapshot set schema_version=1 where id='${restore.id}'`)
  check(textOf(await shell(B, sid, "cat /workspace/safety.txt")).includes("v2"), "修正兼容性后重试恢复原代码")

  await shell(B, sid, "printf v3 > /workspace/safety.txt")
  const beforeRefresh = count(sid)
  // 只对本轮会话快进 checkpoint age；活动时间始终维持在当前时间。
  sql(`update session_snapshot set time_created=time_created-120000 where session_id='${sid}'`)
  sql(`update sandbox set time_created=time_created-120000 where session_id='${sid}'`)
  const deadline = Date.now() + 120000
  while (Date.now() < deadline && count(sid) === beforeRefresh) {
    console.log("维持会话活跃，等待独立周期检查点（idle-reap=0）")
    await shell(B, sid, "echo active-checkpoint")
    await sleep(5000)
  }
  check(count(sid) > beforeRefresh, "持续活跃且关闭 idle-reap 时仍创建周期检查点")
  await ready(sid)
  check(sql(`select state from sandbox where session_id='${sid}'`) === "running", "周期检查点不销毁源沙箱")

  await api(B, `/api/session/${sid}/kill-sandbox`, "POST", {})
  const recoverable = latest(sid)
  const missingID = randomUUID()
  // 暂时指向不存在的远端 ID，模拟真实 restore-create 失败；不删除备份。
  sql(`update session_snapshot set id='${missingID}' where id='${recoverable.id}'`)
  try {
    await shell(A, sid, "echo RESTORE_FAILURE_MUST_NOT_COLD_START")
    check(sql(`select count(*) from sandbox where session_id='${sid}' and state='running'`) === "0", "远端恢复创建失败也不降级空沙箱")
    check(["ready", "stale"].includes(latest(sid).state), "远端恢复失败保留备份及重试入口")
  } finally {
    sql(`update session_snapshot set id='${recoverable.id}' where id='${missingID}'`)
  }
  check(textOf(await shell(B, sid, "cat /workspace/safety.txt")).includes("v3"), "修正远端 ID 后恢复周期检查点代码")
  success = true
  console.log("ALL PASS")
} finally {
  if (sid && success) {
    console.log(`清理本轮会话 ${sid}`)
    await api(A, `/api/session/${sid}`, "DELETE")
  } else if (sid) console.log(`保留失败会话供排障：${sid}`)
}
