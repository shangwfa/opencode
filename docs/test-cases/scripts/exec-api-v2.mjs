// Verify V2's session.shell command API and durable session.log event stream.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"

const BASE = (process.env.BASE ?? "http://127.0.0.1:14105").replace(/\/$/, "")
const PG_URL = process.env.PG_URL ?? "postgresql://local@127.0.0.1:15432/opencode"
const PASSWORD = process.env.OPENCODE_PASSWORD
const headers = {
  "content-type": "application/json",
  ...(PASSWORD ? { authorization: `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}` } : {}),
}
const shellRows = (sessionID) => {
  const rows = execFileSync(
    "psql",
    [
      PG_URL,
      "-X",
      "-A",
      "-t",
      "-q",
      "-c",
      `SELECT data FROM session_message WHERE session_id='${sessionID}' AND type='shell' ORDER BY seq`,
    ],
    { encoding: "utf8" },
  )
  return rows
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((row) => JSON.parse(row))
}

const create = await fetch(`${BASE}/api/session`, {
  method: "POST",
  headers,
  body: JSON.stringify({ title: "exec-api-v2-probe" }),
})
assert.equal(create.status, 200, `session.create HTTP ${create.status}`)
const created = await create.json()
const sessionID = created.data.id
console.log(`V2 probe session: ${sessionID}`)

async function readLog(path, stopWhen = () => false) {
  const response = await fetch(`${BASE}${path}`, { headers, signal: AbortSignal.timeout(60_000) })
  assert.equal(response.status, 200, `session.log HTTP ${response.status}`)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const events = []
  let buffer = ""
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const blocks = buffer.split(/\r?\n\r?\n/)
    buffer = blocks.pop() ?? ""
    for (const block of blocks) {
      const data = block
        .split(/\r?\n/)
        .find((line) => line.startsWith("data:"))
        ?.slice(5)
        .trim()
      if (!data) continue
      const event = JSON.parse(data)
      events.push(event)
      if (stopWhen(event)) {
        await reader.cancel()
        return events
      }
    }
  }
  return events
}

const command = `echo logs-api-${Date.now()}`
const liveLog = readLog(
  `/api/experimental/session/${sessionID}/log?follow=true`,
  (event) => event.type === "session.shell.ended" && event.data?.shell?.command === command,
)
const shellResponse = await fetch(`${BASE}/api/session/${sessionID}/shell`, {
  method: "POST",
  headers,
  body: JSON.stringify({ command }),
  signal: AbortSignal.timeout(60_000),
})
assert.equal(
  shellResponse.status,
  204,
  `session.shell HTTP ${shellResponse.status}: ${(await shellResponse.text()).slice(0, 300)}`,
)

const liveEvents = await liveLog
const started = liveEvents.find(
  (event) => event.type === "session.shell.started" && event.data?.shell?.command === command,
)
const ended = liveEvents.find((event) => event.type === "session.shell.ended" && event.data?.shell?.command === command)
assert.ok(started, "live session.log did not contain session.shell.started")
assert.ok(ended, "live session.log did not contain session.shell.ended")
assert.equal(ended.data.shell.status, "exited")
assert.equal(ended.data.shell.exit, 0)
assert.match(ended.data.output?.output ?? "", /logs-api-/)
const persisted = shellRows(sessionID).find((message) => message.command === command)
assert.ok(persisted, "PG session_message did not persist the successful shell message")
assert.equal(persisted.status, "exited")
assert.equal(persisted.exit, 0)
console.log("✅ session.shell: HTTP 204; command completed with exit=0")
console.log("✅ session.log live: shell.started -> shell.ended; output persisted in event payload")
console.log("✅ PG session_message: shell command, status and exit code persisted")

const replay = await readLog(`/api/experimental/session/${sessionID}/log?follow=false&after=0`)
const replayStarted = replay.find(
  (event) => event.type === "session.shell.started" && event.data?.shell?.command === command,
)
const replayEnded = replay.find(
  (event) => event.type === "session.shell.ended" && event.data?.shell?.command === command,
)
assert.ok(replayStarted, "session.log replay did not return session.shell.started")
assert.ok(replayEnded, "session.log replay did not return session.shell.ended")
console.log("✅ session.log replay: shell.started and shell.ended are durable and replayable")

const failingCommand = `exit 42 # logs-api-failure-${Date.now()}`
const failureLog = readLog(
  `/api/experimental/session/${sessionID}/log?follow=true`,
  (event) => event.type === "session.shell.ended" && event.data?.shell?.command === failingCommand,
)
const failureResponse = await fetch(`${BASE}/api/session/${sessionID}/shell`, {
  method: "POST",
  headers,
  body: JSON.stringify({ command: failingCommand }),
  signal: AbortSignal.timeout(60_000),
})
assert.equal(failureResponse.status, 204, `failing shell HTTP ${failureResponse.status}`)
const failureEvents = await failureLog
const failed = failureEvents.find(
  (event) => event.type === "session.shell.ended" && event.data?.shell?.command === failingCommand,
)
assert.ok(failed, "session.log did not include the failing shell end event")
assert.equal(failed.data.shell.status, "exited")
assert.equal(failed.data.shell.exit, 42)
const persistedFailure = shellRows(sessionID).find((message) => message.command === failingCommand)
assert.ok(persistedFailure, "PG session_message did not persist the failing shell message")
assert.equal(persistedFailure.exit, 42)
console.log("✅ session.shell failure: non-zero exit code 42 persisted in session.log")

const invalid = await fetch(`${BASE}/api/session/${sessionID}/shell`, {
  method: "POST",
  headers,
  body: JSON.stringify({}),
})
assert.equal(invalid.status, 400, `missing command HTTP ${invalid.status}`)
const missing = await fetch(`${BASE}/api/session/ses_NOTEXIST/shell`, {
  method: "POST",
  headers,
  body: JSON.stringify({ command: "echo must-not-run" }),
})
assert.equal(missing.status, 404, `missing session HTTP ${missing.status}`)
console.log("✅ session.shell validation: missing command=400; missing session=404")

const removed = await fetch(`${BASE}/api/session/${sessionID}`, { method: "DELETE", headers })
assert.ok(removed.status === 200 || removed.status === 204, `session.remove HTTP ${removed.status}`)
console.log("✅ test session cleanup")
