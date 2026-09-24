// Verify V2 session sandbox keep-alive control and PG lifecycle persistence.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"

const BASE = (process.env.BASE ?? "http://127.0.0.1:14106").replace(/\/$/, "")
const BASE_SECONDARY = process.env.BASE_SECONDARY?.replace(/\/$/, "")
const PG_URL = process.env.PG_URL ?? "postgresql://local@127.0.0.1:15432/opencode"
const PASSWORD = process.env.OPENCODE_PASSWORD
const headers = {
  "content-type": "application/json",
  ...(PASSWORD ? { authorization: `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}` } : {}),
}

const sql = (statement) =>
  execFileSync("psql", [PG_URL, "-X", "-A", "-t", "-c", statement], { encoding: "utf8" }).trim()

let sessionID
let childID
try {
  const create = await fetch(`${BASE}/api/session`, {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "sandbox-keepalive-v2" }),
  })
  assert.equal(create.status, 200, `session.create HTTP ${create.status}`)
  const { data: session } = await create.json()
  sessionID = session.id
  console.log(`keep-alive V2 probe session: ${sessionID}`)

  const until = Date.now() + 120_000
  let row
  while (Date.now() < until) {
    const value = sql(
      `SELECT json_build_object('id',id,'state',state,'keep_alive',keep_alive)::text FROM sandbox WHERE session_id='${sessionID}'`,
    )
    if (value) {
      row = JSON.parse(value)
      if (row.state === "running") break
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  assert.ok(row, "automatic root-session boot did not persist a sandbox row")
  assert.equal(row.state, "running")
  assert.equal(Boolean(row.keep_alive), true)
  console.log("✅ root session auto keep-alive: PG row running, keep_alive=true")

  if (BASE_SECONDARY) {
    const remoteID = await fetch(`${BASE_SECONDARY}/api/session/${sessionID}/sandbox`, { headers })
    assert.equal(remoteID.status, 200, `secondary session.sandbox HTTP ${remoteID.status}`)
    assert.equal((await remoteID.json()).sandboxId, row.id)
    const remoteShell = await fetch(`${BASE_SECONDARY}/api/session/${sessionID}/shell`, {
      method: "POST",
      headers,
      body: JSON.stringify({ command: `echo reconnect-${sessionID}` }),
      signal: AbortSignal.timeout(90_000),
    })
    assert.equal(remoteShell.status, 204, `secondary session.shell HTTP ${remoteShell.status}`)
    assert.equal(sql(`SELECT id FROM sandbox WHERE session_id='${sessionID}'`), row.id)
    console.log("✅ cross-instance reconnect: secondary server reused the PG sandbox ID")
  }

  const status = await fetch(`${BASE}/api/experimental/session/${sessionID}/keep-alive`, { headers })
  assert.equal(status.status, 200, `keep-alive GET HTTP ${status.status}`)
  assert.equal((await status.json()).keepAlive, true)

  const release = await fetch(`${BASE}/api/experimental/session/${sessionID}/keep-alive`, {
    method: "POST",
    headers,
    body: JSON.stringify({ enabled: false }),
  })
  assert.equal(release.status, 200, `keep-alive release HTTP ${release.status}`)
  assert.equal((await release.json()).keepAlive, false)
  assert.equal(sql(`SELECT keep_alive <> 0 FROM sandbox WHERE session_id='${sessionID}'`), "f")
  assert.equal(sql(`SELECT state FROM sandbox WHERE session_id='${sessionID}'`), "destroyed")
  const releasedStatus = await fetch(`${BASE}/api/experimental/session/${sessionID}/keep-alive`, { headers })
  assert.equal((await releasedStatus.json()).keepAlive, false)
  console.log("✅ keep-alive release: API and PG report false; sandbox destroyed")

  const keepAndBoot = await fetch(`${BASE}/api/experimental/session/${sessionID}/keep-alive`, {
    method: "POST",
    headers,
    body: JSON.stringify({ enabled: true, boot: true }),
  })
  assert.equal(keepAndBoot.status, 200, `keep-alive boot HTTP ${keepAndBoot.status}`)
  const boot = await keepAndBoot.json()
  assert.equal(boot.keepAlive, true)
  assert.notEqual(boot.sandboxId, row.id)
  assert.equal(sql(`SELECT keep_alive <> 0 FROM sandbox WHERE session_id='${sessionID}'`), "t")
  const idempotentBoot = await fetch(`${BASE}/api/experimental/session/${sessionID}/keep-alive`, {
    method: "POST",
    headers,
    body: JSON.stringify({ enabled: true, boot: true }),
  })
  assert.equal((await idempotentBoot.json()).sandboxId, boot.sandboxId)
  console.log("✅ keep-alive boot: sandbox ID matches persisted row")

  const sandboxResponse = await fetch(`${BASE}/api/session/${sessionID}/sandbox`, { headers })
  assert.equal(sandboxResponse.status, 200, `session.sandbox HTTP ${sandboxResponse.status}`)
  const currentSandboxID = (await sandboxResponse.json()).sandboxId
  assert.equal(currentSandboxID, boot.sandboxId)
  const kill = await fetch(`${BASE}/api/session/${sessionID}/kill-sandbox`, { method: "POST", headers })
  assert.equal(kill.status, 200, `session.killSandbox HTTP ${kill.status}`)
  assert.equal((await kill.json()).destroyed, true)
  assert.equal(sql(`SELECT state FROM sandbox WHERE session_id='${sessionID}'`), "destroyed")
  assert.equal(sql(`SELECT keep_alive <> 0 FROM sandbox WHERE session_id='${sessionID}'`), "t")
  const absent = await fetch(`${BASE}/api/session/${sessionID}/sandbox`, { headers })
  assert.equal((await absent.json()).sandboxId, null)
  console.log("✅ kill-sandbox: state destroyed, sandbox ID null, keep_alive preserved")

  const rebuild = await fetch(`${BASE}/api/experimental/session/${sessionID}/keep-alive`, {
    method: "POST",
    headers,
    body: JSON.stringify({ enabled: true, boot: true }),
  })
  assert.equal(rebuild.status, 200, `keep-alive rebuild HTTP ${rebuild.status}`)
  const rebuilt = await rebuild.json()
  assert.equal(rebuilt.keepAlive, true)
  assert.notEqual(rebuilt.sandboxId, currentSandboxID)
  assert.equal(sql(`SELECT state FROM sandbox WHERE session_id='${sessionID}'`), "running")
  assert.equal(sql(`SELECT keep_alive <> 0 FROM sandbox WHERE session_id='${sessionID}'`), "t")
  console.log("✅ destroy/rebuild: preference retained and sandbox recreated")

  // A fork needs at least one durable message; synthetic with resume:false only
  // feeds the pending inbox, so seed the session with a persisted shell message.
  const seedShell = await fetch(`${BASE}/api/session/${sessionID}/shell`, {
    method: "POST",
    headers,
    body: JSON.stringify({ command: "echo fork-seed" }),
    signal: AbortSignal.timeout(90_000),
  })
  assert.equal(seedShell.status, 204, `seed session.shell HTTP ${seedShell.status}`)
  const forkResponse = await fetch(`${BASE}/api/session/${sessionID}/fork`, {
    method: "POST",
    headers,
    body: JSON.stringify({}),
  })
  assert.equal(forkResponse.status, 200, `session.fork HTTP ${forkResponse.status}`)
  const { data: child } = await forkResponse.json()
  childID = child.id
  const childSandbox = await fetch(`${BASE}/api/session/${child.id}/sandbox`, { headers })
  assert.equal(childSandbox.status, 200)
  assert.equal((await childSandbox.json()).sandboxId, null)
  assert.equal(sql(`SELECT count(*) FROM sandbox WHERE session_id='${child.id}'`), "0")
  console.log("✅ forked child session: no automatic sandbox boot")

  const childShell = await fetch(`${BASE}/api/session/${child.id}/shell`, {
    method: "POST",
    headers,
    body: JSON.stringify({ command: `echo child-${child.id}` }),
    signal: AbortSignal.timeout(90_000),
  })
  assert.equal(childShell.status, 204, `child session.shell HTTP ${childShell.status}`)
  assert.equal(sql(`SELECT state FROM sandbox WHERE session_id='${child.id}'`), "running")
  const childRemove = await fetch(`${BASE}/api/session/${child.id}`, { method: "DELETE", headers })
  assert.ok(childRemove.status === 200 || childRemove.status === 204, `child session.remove HTTP ${childRemove.status}`)
  assert.equal(sql(`SELECT state FROM sandbox WHERE session_id='${child.id}'`), "destroyed")
  console.log("✅ forked session removal: its sandbox is destroyed")

  const remove = await fetch(`${BASE}/api/session/${sessionID}`, { method: "DELETE", headers })
  assert.ok(remove.status === 200 || remove.status === 204, `session.remove HTTP ${remove.status}`)
  assert.equal(sql(`SELECT state FROM sandbox WHERE session_id='${sessionID}'`), "destroyed")
  assert.equal(sql(`SELECT keep_alive <> 0 FROM sandbox WHERE session_id='${sessionID}'`), "t")
  console.log("✅ session.remove: sandbox destroyed; keep_alive preference retained")
} finally {
  for (const id of [childID, sessionID].filter(Boolean)) {
    await fetch(`${BASE}/api/experimental/session/${id}/keep-alive`, {
      method: "POST",
      headers,
      body: JSON.stringify({ enabled: false }),
    }).catch(() => {})
    await fetch(`${BASE}/api/session/${id}`, { method: "DELETE", headers }).catch(() => {})
  }
}
