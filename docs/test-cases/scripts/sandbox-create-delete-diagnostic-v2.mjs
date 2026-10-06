// Diagnostic only: inject create failures, then observe whether a deleted
// Session can acquire another creating lease. No remote sandbox is created.
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../../..")
const nonce = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
const name = `opencode-create-delete-diagnostic-${nonce}`
const out = path.join(root, "docs/test-cases/sandbox/store/evidence", name)
mkdirSync(out, { recursive: true })
const source = JSON.parse(execFileSync("docker", ["inspect", "opencode-saas-test"], { encoding: "utf8" }))[0]
const env = Object.fromEntries(
  source.Config.Env.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
)
const url = new URL(process.env.OPENCODE_DATABASE_URL ?? "")
assert(/test|lifecycle/.test(url.pathname), "只允许专用测试 PG")
const adminURL = new URL(url)
adminURL.pathname = "/postgres"
url.pathname = `/opencode-v2-create-delete-diagnostic-${nonce}`
const db = new Bun.SQL(url.toString())
const port = Number(process.env.PROBE_PORT ?? 14135)
const headers = {
  "Content-Type": "application/json",
  Authorization:
    "Basic " +
    Buffer.from(`${env.OPENCODE_SERVER_USERNAME ?? "opencode"}:${env.OPENCODE_SERVER_PASSWORD ?? ""}`).toString(
      "base64",
    ),
}
const report = { reproduced: false, database: url.pathname.slice(1), creates: [], observations: [] }
let firstRelease, secondRelease
const first = new Promise((resolve) => {
  firstRelease = resolve
})
const second = new Promise((resolve) => {
  secondRelease = resolve
})
const proxy = Bun.serve({
  hostname: "0.0.0.0",
  port: 0,
  idleTimeout: 255,
  async fetch(request) {
    if (request.method === "POST" && new URL(request.url).pathname === "/v1/sandboxes") {
      const payload = await request.json()
      report.creates.push({ time: Date.now(), session: payload.metadata?.session })
      if (report.creates.length === 1) await first
      if (report.creates.length === 2) await second
      return Response.json({ code: "INJECTED_CREATE_FAILURE", message: "diagnostic create failure" }, { status: 503 })
    }
    return Response.json({ message: "diagnostic endpoint not found" }, { status: 404 })
  },
})
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(read, predicate, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await read()
    if (predicate(value)) return value
    await pause(25)
  }
  throw new Error("诊断条件等待超时")
}
async function api(method, route, payload) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers,
    body: payload === undefined ? undefined : JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null }
}
let sessionID
try {
  const admin = new Bun.SQL(adminURL.toString())
  try {
    await admin.unsafe(`CREATE DATABASE "${report.database}"`)
  } finally {
    await admin.close()
  }
  const dockerURL = new URL(url)
  dockerURL.hostname = "host.docker.internal"
  const args = ["run", "-d", "--name", name, "--no-healthcheck", "-p", `${port}:4096`]
  for (const pkg of ["core", "server", "protocol"])
    args.push("-v", `${root}/packages/${pkg}/src:/app/packages/${pkg}/src:ro`)
  for (const [key, value] of Object.entries({
    ...env,
    OPENCODE_DATABASE_URL: dockerURL.toString(),
    OPENCODE_SANDBOX_PROTOCOL: "http",
    OPENCODE_SANDBOX_DOMAIN: `host.docker.internal:${proxy.port}`,
    OPENCODE_SANDBOX_VOLUME_TYPE: "snapshot",
    OPENCODE_SANDBOX_SNAPSHOT_ENABLED: "true",
    OPENCODE_SESSION_AUTO_KEEPALIVE: "true",
    OPENCODE_SANDBOX_IDLE_REAP_SEC: "3600",
  }))
    args.push("-e", `${key}=${value}`)
  args.push(source.Config.Image)
  execFileSync("docker", args, { stdio: "ignore" })
  await until(
    async () => {
      try {
        return (await api("GET", "/api/info")).status === 200
      } catch {
        return false
      }
    },
    Boolean,
    90000,
  )
  const created = await api("POST", "/api/session", {
    title: name,
    location: { directory: "/workspace" },
    sandbox: { cpu: "1", memory: "2Gi", image: env.OPENCODE_SANDBOX_IMAGE, persistMode: "snapshot" },
  })
  assert.equal(created.status, 200)
  sessionID = created.body.data.id
  report.sessionID = sessionID
  await until(
    async () => report.creates.length,
    (n) => n === 1,
  )
  firstRelease()
  await until(
    async () => (await db`select id,state from sandbox where session_id=${sessionID}`)[0],
    (row) => row?.state === "destroyed",
  )
  const removed = await api("DELETE", `/api/session/${sessionID}`)
  assert.equal(removed.status, 204)
  report.observations.push({ phase: "deleted", time: Date.now(), status: removed.status })
  if (process.env.PROBE_EXPECT_BLOCKED === "true") {
    await pause(3500)
    const rows = await db`select id,state from sandbox where session_id=${sessionID}`
    const sessions = (await db`select count(*)::int as n from session_v2 where id=${sessionID}`)[0].n
    report.observations.push({ phase: "closed-retry-check", sessions, rows, creates: report.creates.length })
    assert.equal(report.creates.length, 1, "已删除 Session 不得再次发出建箱请求")
    assert.equal(sessions, 0)
    assert(
      rows.every((row) => row.state === "destroyed"),
      "已删除 Session 不得重新申请 creating 租约",
    )
    report.regressionPassed = true
  } else {
    await until(
      async () => report.creates.length,
      (n) => n >= 2,
    )
    const sessions = (await db`select count(*)::int as n from session_v2 where id=${sessionID}`)[0].n
    const rows = await db`select id,state from sandbox where session_id=${sessionID}`
    report.observations.push({ phase: "retry-after-delete", time: Date.now(), sessions, rows })
    report.reproduced = sessions === 0 && rows.some((row) => row.state === "creating")
    assert(report.reproduced, "本轮未复现 deleted Session 再次建箱")
    secondRelease()
    await until(
      async () => report.creates.length,
      (n) => n >= 3,
    )
    await until(
      async () => (await db`select state from sandbox where session_id=${sessionID}`)[0],
      (row) => row?.state === "destroyed",
    )
  }
  report.postcheck = {
    sessions: (await db`select count(*)::int as n from session_v2`)[0].n,
    rows: await db`select id,state from sandbox`,
  }
} catch (error) {
  report.error = String(error)
  process.exitCode = 1
} finally {
  firstRelease()
  secondRelease()
  if (sessionID && report.creates.length > 1) {
    try {
      await until(
        async () => report.creates.length,
        (n) => n >= 3,
      )
      await until(
        async () => (await db`select state from sandbox where session_id=${sessionID}`)[0],
        (row) => row?.state === "destroyed",
      )
    } catch (error) {
      report.cleanupError = String(error)
    }
  }
  const logs = spawnSync("docker", ["logs", name], { encoding: "utf8", maxBuffer: 4000000 })
  writeFileSync(path.join(out, "saas.log"), (logs.stdout ?? "") + (logs.stderr ?? ""))
  spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" })
  writeFileSync(path.join(out, "result.json"), JSON.stringify(report, null, 2))
  proxy.stop(true)
  await db.close()
  console.log(
    JSON.stringify({
      reproduced: report.reproduced,
      regressionPassed: report.regressionPassed,
      error: report.error,
      evidence: out,
    }),
  )
}
