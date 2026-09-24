// Verify session.create returns 404 (not 500) for a missing parentID, creates nothing in PG,
// and stays idempotent for a client-supplied id.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"

const BASE = (process.env.BASE ?? "http://127.0.0.1:14106").replace(/\/$/, "")
const PG_URL = process.env.PG_URL ?? "postgresql://local@127.0.0.1:5432/opencode-v2-up"
const PASSWORD = process.env.OPENCODE_PASSWORD
const headers = {
  "content-type": "application/json",
  ...(PASSWORD ? { authorization: `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}` } : {}),
}

const sessionRow = (sessionID) =>
  execFileSync("psql", [PG_URL, "-X", "-A", "-t", "-q", "-c", `SELECT count(*) FROM session_v2 WHERE id='${sessionID}'`], {
    encoding: "utf8",
  }).trim()

const missingParent = `ses_${globalThis.crypto.randomUUID().replaceAll("-", "")}`
const childID = `ses_${globalThis.crypto.randomUUID().replaceAll("-", "")}`

// 1. Missing parentID -> 404 with a semantic error body.
const rejected = await fetch(`${BASE}/api/session`, {
  method: "POST",
  headers,
  body: JSON.stringify({ id: childID, parentID: missingParent }),
})
assert.equal(rejected.status, 404, `expected 404, got HTTP ${rejected.status}`)
const rejectedBody = await rejected.json()
assert.equal(rejectedBody._tag, "SessionNotFoundError", JSON.stringify(rejectedBody))
assert.equal(rejectedBody.sessionID, missingParent)
console.log(`✓ missing parentID -> 404 SessionNotFoundError (sessionID=${missingParent})`)

// 2. PG: neither the child nor a phantom row was created.
assert.equal(sessionRow(childID), "0", "child session must not exist in PG")
console.log("✓ PG session_v2 has no row for the rejected child id")

// 3. Normal create with the same client id succeeds and is idempotent.
const first = await fetch(`${BASE}/api/session`, {
  method: "POST",
  headers,
  body: JSON.stringify({ id: childID, title: "create-404-e2e" }),
})
assert.equal(first.status, 200, `session.create HTTP ${first.status}`)
const firstBody = await first.json()
assert.equal(firstBody.data.id, childID)

const second = await fetch(`${BASE}/api/session`, {
  method: "POST",
  headers,
  body: JSON.stringify({ id: childID, title: "create-404-e2e-retry" }),
})
const secondBody = await second.json()
assert.deepEqual(secondBody, firstBody, "duplicate id must return the existing session unchanged")
console.log(`✓ client-supplied id is idempotent (${childID})`)

// 4. PG: exactly one row for the id.
assert.equal(sessionRow(childID), "1", "exactly one PG row expected")
console.log("✓ PG session_v2 has exactly one row for the created id")

console.log("\nAll session.create e2e checks passed.")
