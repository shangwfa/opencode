// Verify V2 session-scoped file read/list/find APIs backed by the sandbox.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"

const BASE = (process.env.BASE ?? "http://127.0.0.1:14107").replace(/\/$/, "")
const PG_URL = process.env.PG_URL ?? "postgresql://local@127.0.0.1:15432/opencode"
const PASSWORD = process.env.OPENCODE_PASSWORD
const headers = {
  "content-type": "application/json",
  ...(PASSWORD ? { authorization: `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}` } : {}),
}
const sql = (statement) =>
  execFileSync("psql", [PG_URL, "-X", "-A", "-t", "-q", "-c", statement], { encoding: "utf8" }).trim()

const created = await fetch(`${BASE}/api/session`, {
  method: "POST",
  headers,
  body: JSON.stringify({ title: "files-api-v2" }),
})
assert.equal(created.status, 200, `session.create HTTP ${created.status}`)
const { data: session } = await created.json()
const sessionID = session.id

const noSandbox = await fetch(`${BASE}/api/session/${sessionID}/fs/list`, { headers })
assert.equal(noSandbox.status, 404, `fs.list before boot HTTP ${noSandbox.status}`)
assert.equal(sql(`SELECT count(*) FROM sandbox WHERE session_id='${sessionID}'`), "0")
console.log("✅ session.fs.list: idle session returns 404 without booting a sandbox")

const command = String.raw`mkdir -p /workspace/files-v2/nested && printf 'needle text v2\n' > /workspace/files-v2/nested/readme.txt && printf '\000\001\377\n' > /workspace/files-v2/payload.bin && printf '\211PNG\r\n\032\n' > /workspace/files-v2/image.png && touch /workspace/files-v2/.hidden`
const shell = await fetch(`${BASE}/api/session/${sessionID}/shell`, {
  method: "POST",
  headers,
  body: JSON.stringify({ command }),
  signal: AbortSignal.timeout(90_000),
})
assert.equal(shell.status, 204, `session.shell HTTP ${shell.status}`)
const runningID = sql(`SELECT id FROM sandbox WHERE session_id='${sessionID}'`)
assert.ok(runningID)
assert.equal(sql(`SELECT state FROM sandbox WHERE session_id='${sessionID}'`), "running")

const listURL = new URL(`${BASE}/api/session/${sessionID}/fs/list`)
listURL.searchParams.set("path", "files-v2")
const listed = await fetch(listURL, { headers })
assert.equal(listed.status, 200, `session.fs.list HTTP ${listed.status}`)
const entries = (await listed.json()).data
assert.deepEqual(
  entries.sort((a, b) => a.path.localeCompare(b.path)),
  [
    { path: "files-v2/.hidden", type: "file" },
    { path: "files-v2/image.png", type: "file" },
    { path: "files-v2/nested", type: "directory" },
    { path: "files-v2/payload.bin", type: "file" },
  ],
)
console.log("✅ session.fs.list: returns workspace-relative paths and entry types")

const readURL = (relative) =>
  `${BASE}/api/session/${sessionID}/fs/read/${relative.split("/").map(encodeURIComponent).join("/")}`
const textRead = await fetch(readURL("files-v2/nested/readme.txt"), { headers })
assert.equal(textRead.status, 200, `session.fs.read text HTTP ${textRead.status}`)
assert.equal(textRead.headers.get("content-type"), "text/plain")
assert.equal(await textRead.text(), "needle text v2\n")

const binaryRead = await fetch(readURL("files-v2/payload.bin"), { headers })
assert.equal(binaryRead.status, 200, `session.fs.read binary HTTP ${binaryRead.status}`)
assert.equal(binaryRead.headers.get("content-type"), "application/octet-stream")
assert.deepEqual(Buffer.from(await binaryRead.arrayBuffer()), Buffer.from([0, 1, 255, 10]))

const pngRead = await fetch(readURL("files-v2/image.png"), { headers })
assert.equal(pngRead.status, 200, `session.fs.read png HTTP ${pngRead.status}`)
assert.equal(pngRead.headers.get("content-type"), "image/png")
assert.deepEqual(
  Buffer.from(await pngRead.arrayBuffer()),
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
)
console.log("✅ session.fs.read: text/binary bytes and text/octet-stream/png MIME match")

const findURL = new URL(`${BASE}/api/session/${sessionID}/fs/find`)
findURL.searchParams.set("query", "readme.txt")
findURL.searchParams.set("type", "file")
const found = await fetch(findURL, { headers })
assert.equal(found.status, 200, `session.fs.find HTTP ${found.status}`)
assert.deepEqual((await found.json()).data, [{ path: "files-v2/nested/readme.txt", type: "file" }])

const noMatchURL = new URL(`${BASE}/api/session/${sessionID}/fs/find`)
noMatchURL.searchParams.set("query", "no-such-v2-file")
const noMatch = await fetch(noMatchURL, { headers })
assert.equal(noMatch.status, 200)
assert.deepEqual((await noMatch.json()).data, [])
console.log("✅ session.fs.find: file filtering and empty results")

const missing = await fetch(readURL("files-v2/no-such-file"), { headers })
assert.equal(missing.status, 404, `missing file HTTP ${missing.status}`)
const traversalURL = new URL(`${BASE}/api/session/${sessionID}/fs/list`)
traversalURL.searchParams.set("path", "../../etc")
const traversal = await fetch(traversalURL, { headers })
assert.equal(traversal.status, 404, `workspace traversal HTTP ${traversal.status}`)
console.log("✅ session filesystem errors: missing file and path escape return 404")

const kill = await fetch(`${BASE}/api/session/${sessionID}/kill-sandbox`, { method: "POST", headers })
assert.equal(kill.status, 200)
assert.equal(sql(`SELECT state FROM sandbox WHERE session_id='${sessionID}'`), "destroyed")
const afterKill = await fetch(listURL, { headers })
assert.equal(afterKill.status, 404, "file browsing must not implicitly recreate a killed sandbox")
assert.equal(sql(`SELECT state FROM sandbox WHERE session_id='${sessionID}'`), "destroyed")
console.log("✅ after kill-sandbox: fs.list does not boot/recreate sandbox")

const removed = await fetch(`${BASE}/api/session/${sessionID}`, { method: "DELETE", headers })
assert.ok(removed.status === 200 || removed.status === 204, `session.remove HTTP ${removed.status}`)
assert.equal(sql(`SELECT state FROM sandbox WHERE session_id='${sessionID}'`), "destroyed")
assert.equal(sql(`SELECT id FROM sandbox WHERE session_id='${sessionID}'`), runningID)
console.log("✅ session cleanup: sandbox PG row retained as destroyed")
