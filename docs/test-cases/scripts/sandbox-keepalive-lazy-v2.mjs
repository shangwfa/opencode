// Verify keep-alive boot=false persists a pending preference without creating a sandbox.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"

const BASE = (process.env.BASE ?? "http://127.0.0.1:14107").replace(/\/$/, "")
const PG_URL = process.env.PG_URL ?? "postgresql://local@127.0.0.1:5432/opencode-v2-up"
const PASSWORD = process.env.OPENCODE_PASSWORD
const headers = {
  "content-type": "application/json",
  ...(PASSWORD ? { authorization: `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}` } : {}),
}
const sql = (query) => execFileSync("psql", [PG_URL, "-X", "-A", "-t", "-c", query], { encoding: "utf8" }).trim()

const create = await fetch(`${BASE}/api/session`, {
  method: "POST",
  headers,
  body: JSON.stringify({ title: "sandbox-keepalive-lazy-v2" }),
})
assert.equal(create.status, 200)
const { data: session } = await create.json()
const sid = session.id

const keep = await fetch(`${BASE}/api/experimental/session/${sid}/keep-alive`, {
  method: "POST",
  headers,
  body: JSON.stringify({ enabled: true, boot: false }),
})
assert.equal(keep.status, 200)
const response = await keep.json()
assert.equal(response.keepAlive, true)
assert.equal(response.sandboxId, null)
assert.equal(sql(`SELECT id FROM sandbox WHERE session_id='${sid}'`), `pending-${sid}`)
assert.equal(sql(`SELECT state FROM sandbox WHERE session_id='${sid}'`), "destroyed")
assert.equal(sql(`SELECT keep_alive <> 0 FROM sandbox WHERE session_id='${sid}'`), "t")
console.log("✅ boot=false: PG pending row created with keep_alive=true; no remote sandbox booted")

const shell = await fetch(`${BASE}/api/session/${sid}/shell`, {
  method: "POST",
  headers,
  body: JSON.stringify({ command: "echo lazy-boot" }),
  signal: AbortSignal.timeout(90_000),
})
assert.equal(shell.status, 204)
assert.notEqual(sql(`SELECT id FROM sandbox WHERE session_id='${sid}'`), `pending-${sid}`)
assert.equal(sql(`SELECT state FROM sandbox WHERE session_id='${sid}'`), "running")
assert.equal(sql(`SELECT keep_alive <> 0 FROM sandbox WHERE session_id='${sid}'`), "t")
console.log("✅ first shell use: lazy sandbox created and inherited keep_alive=true")

const remove = await fetch(`${BASE}/api/session/${sid}`, { method: "DELETE", headers })
assert.ok(remove.status === 200 || remove.status === 204)
