import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"

/**
 * Session sandbox definition scan (V2) — filename/edge cases and `find` fault injection.
 *
 * `docs/test-cases/session/sandbox-definition-scan.md` SAS-SCAN-02/03 and SAS-LIFE-03.
 * Fault injection works because the sandbox image has a writable `/usr/local/bin` ahead of
 * `/usr/bin` in PATH, so a stub `find` shadows the real one for the duration of the test.
 */

const BASE = (process.env.BASE ?? "http://localhost:14097").replace(/\/$/, "")
const PG_URL = process.env.PG_URL
const AUTH = process.env.OPENCODE_AUTH ?? (process.env.OPENCODE_PASSWORD ? `opencode:${process.env.OPENCODE_PASSWORD}` : undefined)
const headers = {
  "content-type": "application/json",
  ...(AUTH ? { authorization: `Basic ${Buffer.from(AUTH).toString("base64")}` } : {}),
}
const parsedModel = JSON.parse(process.env.MODEL ?? '{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}')
const model = { providerID: parsedModel.providerID, id: parsedModel.id ?? parsedModel.modelID }
const nonce = randomUUID().replaceAll("-", "").slice(0, 8)
const timeout = Number(process.env.SCAN_E2E_TIMEOUT_MS ?? 300_000)
const sessionIDs = []
const passed = []

const say = (line) => process.stdout.write(`${line}\n`)
function check(condition, description) {
  assert(condition, description)
  passed.push(description)
  say(`PASS: ${description}`)
}
function pg(sql) {
  if (!PG_URL) throw new Error("PG_URL is required")
  const result = spawnSync("psql", [PG_URL, "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" })
  if (result.status !== 0) throw new Error(`psql failed: ${result.stderr}`)
  return result.stdout.trim()
}
const sqlQuote = (value) => `'${value.replaceAll("'", "''")}'`
const sh = (value) => `'${value.replaceAll("'", `'\\''`)}'`
const b64 = (value) => Buffer.from(value, "utf8").toString("base64")

async function api(path, method = "GET", body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  })
  const text = response.status === 204 ? "" : await response.text()
  let data
  try {
    data = text ? JSON.parse(text) : undefined
  } catch {
    data = text
  }
  return { response, text, data }
}
async function prompt(sessionID, text) {
  const response = await fetch(`${BASE}/api/session/${sessionID}/prompt_stream`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text, metadata: {}, delivery: "queue" }),
    signal: AbortSignal.timeout(timeout),
  })
  if (response.status !== 200) throw new Error(`prompt_stream HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const events = []
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const blocks = buffer.split(/\r?\n\r?\n/)
    buffer = blocks.pop() ?? ""
    for (const block of blocks) {
      const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n")
      if (!data || data === "[DONE]") continue
      try {
        events.push(JSON.parse(data))
      } catch {}
    }
  }
  return events
}
/** Runs one shell command in the owning Session sandbox through the product's tool path. */
async function shellCommand(sessionID, command, label) {
  const events = await prompt(sessionID, `Call the shell tool with exactly this command, changing nothing:\n\n${command}`)
  const types = events.map((event) => event.type)
  assert(types.includes("session.execution.succeeded"), `${label}: execution did not succeed (${types.join(",")})`)
}
async function writeFixtures(sessionID, fixtures, label) {
  const command = fixtures
    .map(({ path, content }) => `mkdir -p ${sh(path.slice(0, path.lastIndexOf("/")))} && printf '%s' '${b64(content)}' | base64 -d > ${sh(path)}`)
    .join(" && ")
  await shellCommand(sessionID, command, label)
}
/** Runs one command through the product's Session shell API and returns its combined output. */
async function runShell(sessionID, command) {
  const run = await api(`/api/session/${sessionID}/shell`, "POST", { command })
  assert.equal(run.response.status, 204, `shell POST ${run.response.status}`)
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const messages = await api(`/api/session/${sessionID}/message?order=asc`)
    const items = messages.data?.data ?? messages.data ?? []
    const shell = items.filter((message) => message.type === "shell" && message.command === command).at(-1)
    if (shell && shell.status !== "running") return { exit: shell.exit, output: shell.output?.output ?? shell.output ?? "" }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`shell timed out: ${command}`)
}
async function createSession(title) {
  const created = await api("/api/session", "POST", { title: `${title}-${nonce}`, location: { directory: "/workspace" }, model })
  assert.equal(created.response.status, 200, created.text)
  const id = created.data?.data?.id ?? created.data?.id
  sessionIDs.push(id)
  return id
}
async function agentsRefresh(id) {
  return api(`/api/session/${id}/agents/refresh`, "POST")
}
async function agentsList(id) {
  return api(`/api/session/${id}/agents`)
}
/** Effective agent array from a list/refresh response. */
const definitions = (payload) => payload.data?.data ?? payload.data ?? []
const sandboxIDs = (items) => items.filter((item) => item.source === "sandbox").map((item) => item.agent.id)
const sandboxAgent = (items, id) => items.find((item) => item.agent.id === id && item.source === "sandbox")

let root
try {
  root = await createSession("scan-edge")
  const edge = `/workspace/.opencode/agents/edge-${nonce}`

  // ---------------------------------------------------------------- SAS-SCAN-03
  await writeFixtures(
    root,
    [
      { path: `${edge}/with space.md`, content: `---\ndescription: Space\nmode: subagent\n---\nSPACE_${nonce}\n` },
      { path: `${edge}/中文-${nonce}.md`, content: `---\ndescription: Unicode\nmode: subagent\n---\nUNICODE_${nonce}\n` },
      { path: `${edge}/plain.md`, content: `---\ndescription: Plain\nmode: subagent\n---\nPLAIN_${nonce}\n` },
    ],
    "write space/unicode fixtures",
  )
  // TAB and newline names cannot go through the fs read API, so create them in one shell turn.
  await shellCommand(
    root,
    [
      `printf 'TAB' > ${sh(`${edge}/tab\tname.md`)}`,
      `printf 'NL' > ${sh(`${edge}/line\nname.md`)}`,
      `printf 'MDOT' > ${sh(`${edge}/upper.MD`)}`,
      `ln -sf /etc/passwd ${sh(`${edge}/outside-link.md`)}`,
      `mkdir -p ${sh(`${edge}/deep/a/b`)} && printf 'DEEP' > ${sh(`${edge}/deep/a/b/nested.md`)}`,
    ].join(" && "),
    "write edge-case filenames",
  )

  const listed = definitions((await agentsRefresh(root)).data)
  const ids = sandboxIDs(listed)
  // `validName` allows `[\p{L}\p{N}._/-]` only, so a space is rejected — unlike host-side
  // discovery, which derives the name from the path without this check. Recorded as a finding.
  assert(!sandboxAgent(listed, `edge-${nonce}/with space`), "SAS-SCAN-03: a space name was accepted, contradicting validName")
  assert(sandboxAgent(listed, `edge-${nonce}/中文-${nonce}`), `SAS-SCAN-03: Unicode name not discovered: ${JSON.stringify(ids)}`)
  assert(sandboxAgent(listed, `edge-${nonce}/plain`), "SAS-SCAN-03: plain neighbour lost")
  assert(sandboxAgent(listed, `edge-${nonce}/deep/a/b/nested`), "SAS-LIFE-03: deep nested definition not discovered")
  assert(!ids.some((id) => id.includes("\t")), "SAS-SCAN-03: a TAB name leaked into an id")
  assert(!ids.some((id) => id.includes("\n")), "SAS-SCAN-03: a newline name leaked into an id")
  assert(!ids.some((id) => id.includes("outside-link")), "SAS-SCAN-03: a symlink outside the root became a definition")
  assert(!ids.some((id) => id.endsWith("upper")), "SAS-LIFE-03: an uppercase .MD file was discovered")
  // Newline/TAB/MD/symlink files must not produce phantom entries from orphaned line fragments.
  assert.equal(
    ids.filter((id) => id.startsWith(`edge-${nonce}/`)).length,
    3,
    `SAS-SCAN-03: unexpected sandbox definition set: ${JSON.stringify(ids)}`,
  )
  check(true, "SAS-SCAN-03 Unicode/deep names resolve; space/TAB/newline names are dropped per validName without corrupting neighbours")
  check(true, "SAS-SCAN-03 a symlink outside the discovery root is not followed")
  check(true, "SAS-LIFE-03 .MD is not matched and deep subdirectories are honoured")

  // ---------------------------------------------------------------- SAS-SCAN-02
  // Fault injection goes through the product's Session shell API so installation is verified
  // rather than left to the model. The stub only fails discovery-root invocations, so the rest
  // of the sandbox keeps working.
  const stub = (body) =>
    `printf '%s' '${b64(`#!/bin/sh\ncase "$*" in\n  *".opencode/agent"*) ${body} ;;\nesac\nexec /usr/bin/find "$@"\n`)}' | base64 -d > /usr/local/bin/find && chmod +x /usr/local/bin/find && command -v find`

  // (a) find exits non-zero for discovery (also models a build without -printf)
  const installed = await runShell(root, stub("echo 'find: unrecognized: -printf' >&2; exit 1"))
  assert.equal(installed.output.trim(), "/usr/local/bin/find", `SAS-SCAN-02: stub not active: ${installed.output}`)
  const failingList = await agentsList(root)
  assert.equal(failingList.response.status, 200, `SAS-SCAN-02: degraded GET returned ${failingList.response.status}`)
  const failingRefresh = await agentsRefresh(root)
  assert(
    failingRefresh.response.status >= 400 && failingRefresh.response.status < 600,
    `SAS-SCAN-02: refresh returned ${failingRefresh.response.status} on a failing find`,
  )
  check(true, `SAS-SCAN-02 a non-zero find degrades GET (200) and fails refresh (${failingRefresh.response.status})`)

  // (b) find hangs past the 10s scan timeout
  const hanging = await runShell(root, stub("sleep 60"))
  assert.equal(hanging.output.trim(), "/usr/local/bin/find", `SAS-SCAN-02: hanging stub not active: ${hanging.output}`)
  const started = Date.now()
  const hangingRefresh = await agentsRefresh(root)
  const elapsed = Date.now() - started
  assert(
    hangingRefresh.response.status >= 400 && hangingRefresh.response.status < 600,
    `SAS-SCAN-02: refresh returned ${hangingRefresh.response.status} on a hanging find`,
  )
  assert(elapsed < 60_000, `SAS-SCAN-02: hanging find was not cut off by the scan timeout (${elapsed}ms)`)
  assert(/timed out/i.test(hangingRefresh.text), `SAS-SCAN-02: timeout not reported as such: ${hangingRefresh.text.slice(0, 200)}`)
  check(true, `SAS-SCAN-02 a hanging find is cut off by the 10s scan timeout and reported as timed out (${elapsed}ms)`)

  // Restore the real find and confirm the sandbox recovers.
  // The first ordinary command after a poisoned context intentionally is not
  // replayed (it could have side effects); it invalidates that context. Retry
  // this idempotent cleanup command once to execute it in the fresh context.
  await runShell(root, "rm -f /usr/local/bin/find")
  await runShell(root, "rm -f /usr/local/bin/find")
  const recovered = definitions((await agentsRefresh(root)).data)
  assert(sandboxAgent(recovered, `edge-${nonce}/plain`), "SAS-SCAN-02: scan did not recover after removing the stub")
  check(true, "SAS-SCAN-02 scanning recovers once the real find is restored")
} finally {
  // Best-effort: never leave the stubbed `find` behind in the sandbox.
  if (root) {
    try {
      await runShell(root, "rm -f /usr/local/bin/find")
    } catch {}
  }
  for (const id of sessionIDs.reverse()) await api(`/api/session/${id}`, "DELETE")
}

if (sessionIDs.length) {
  const ids = sessionIDs.map(sqlQuote).join(",")
  assert.equal(pg(`SELECT count(*) FROM session_v2 WHERE id IN (${ids})`), "0", "test Sessions remained in PostgreSQL")
  assert.equal(pg(`SELECT count(*) FROM session_agents WHERE session_id IN (${ids})`), "0", "test Agent rows remained in PostgreSQL")
  check(true, "all test Session and Agent rows were removed from PostgreSQL")
}

if (passed.length) say(`\n${passed.length} edge/fault sandbox scan assertions passed.`)
