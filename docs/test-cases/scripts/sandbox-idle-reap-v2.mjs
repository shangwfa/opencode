// Verify idle reap after a server restart, including persisted keep-alive preference.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"

const BASE = (process.env.BASE ?? "http://127.0.0.1:14107").replace(/\/$/, "")
const PG_URL = process.env.PG_URL ?? "postgresql://local@127.0.0.1:5432/opencode-v2-up"
const PASSWORD = process.env.OPENCODE_PASSWORD
const CONTAINER = process.env.RESTART_CONTAINER
assert.ok(CONTAINER, "RESTART_CONTAINER must name the V2 server container to restart")

const headers = {
  "content-type": "application/json",
  ...(PASSWORD ? { authorization: `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}` } : {}),
}
const sql = (statement) =>
  execFileSync("psql", [PG_URL, "-X", "-A", "-t", "-q", "-c", statement], { encoding: "utf8" }).trim()
const waitForSessionAPI = async () => {
  const until = Date.now() + 90_000
  while (Date.now() < until) {
    const response = await fetch(`${BASE}/api/session/${sessionID}`, { headers }).catch(() => null)
    if (response?.status === 200) return
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error("V2 server did not become ready after restart")
}

const created = await fetch(`${BASE}/api/session`, {
  method: "POST",
  headers,
  body: JSON.stringify({ title: "sandbox-idle-reap-v2" }),
})
assert.equal(created.status, 200, `session.create HTTP ${created.status}`)
const { data: session } = await created.json()
const sessionID = session.id

const boot = await fetch(`${BASE}/api/experimental/session/${sessionID}/keep-alive`, {
  method: "POST",
  headers,
  body: JSON.stringify({ enabled: true, boot: true }),
})
assert.equal(boot.status, 200, `keep-alive boot HTTP ${boot.status}`)
const bootInfo = await boot.json()
assert.ok(bootInfo.sandboxId, "boot=true did not return a sandbox ID")
assert.equal(sql(`SELECT state FROM sandbox WHERE session_id='${sessionID}'`), "running")
assert.equal(sql(`SELECT keep_alive <> 0 FROM sandbox WHERE session_id='${sessionID}'`), "t")

execFileSync("docker", ["restart", CONTAINER], { stdio: "ignore" })
await waitForSessionAPI()
const reconnect = await fetch(`${BASE}/api/session/${sessionID}/shell`, {
  method: "POST",
  headers,
  body: JSON.stringify({ command: `echo restart-reconnect-${sessionID}` }),
  signal: AbortSignal.timeout(90_000),
})
assert.equal(reconnect.status, 204, `shell after server restart HTTP ${reconnect.status}`)
assert.equal(sql(`SELECT id FROM sandbox WHERE session_id='${sessionID}'`), bootInfo.sandboxId)
assert.equal(sql(`SELECT state FROM sandbox WHERE session_id='${sessionID}'`), "running")
console.log("✅ server restart: existing sandbox ID reconnected and shell completed")

// Make the persisted activity timestamp stale, then restart so the provider's
// immediate first idle-reap pass sees the row (the normal periodic interval is 5m).
assert.equal(sql(`UPDATE sandbox SET time_updated=0 WHERE session_id='${sessionID}' RETURNING session_id`), sessionID)
execFileSync("docker", ["restart", CONTAINER], { stdio: "ignore" })
await waitForSessionAPI()

const until = Date.now() + 90_000
let state = ""
while (Date.now() < until) {
  const response = await fetch(`${BASE}/api/session/${sessionID}/sandbox`, { headers }).catch(() => null)
  if (response?.status === 200) {
    const sandbox = await response.json()
    state = sql(`SELECT state FROM sandbox WHERE session_id='${sessionID}'`)
    if (state === "destroyed" && sandbox.sandboxId === null) break
  }
  await new Promise((resolve) => setTimeout(resolve, 1000))
}

assert.equal(state, "destroyed", "idle reaper did not mark the stale sandbox destroyed")
assert.equal(sql(`SELECT keep_alive <> 0 FROM sandbox WHERE session_id='${sessionID}'`), "t")
const keepAlive = await fetch(`${BASE}/api/experimental/session/${sessionID}/keep-alive`, { headers })
assert.equal(keepAlive.status, 200)
assert.equal((await keepAlive.json()).keepAlive, true)
console.log("✅ idle-reap: stale sandbox destroyed after restart; keep_alive preference retained")

const removed = await fetch(`${BASE}/api/session/${sessionID}`, { method: "DELETE", headers })
assert.ok(removed.status === 200 || removed.status === 204, `session.remove HTTP ${removed.status}`)
