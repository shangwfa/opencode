import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"

/**
 * Session sandbox definition scan (V2) — command precedence/execution, subagent sandbox sharing,
 * and sandbox recreation. Companion to `sandbox-definition-scan-v2.mjs`; see
 * `docs/test-cases/session/sandbox-definition-scan.md` sections 3, 4 and SAS-SH-01/SH-03.
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
const timeout = Number(process.env.SCAN_E2E_TIMEOUT_MS ?? 420_000)
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
const shellQuote = (value) => `'${value.replaceAll("'", `'\\''`)}'`

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
function status(result, expected, label) {
  assert.equal(result.response.status, expected, `${label}: ${result.text}`)
  return result.data
}
async function prompt(sessionID, text) {
  const response = await fetch(`${BASE}/api/session/${sessionID}/prompt_stream`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text, metadata: {}, delivery: "queue" }),
    signal: AbortSignal.timeout(timeout),
  })
  if (response.status !== 200) throw new Error(`prompt_stream HTTP ${response.status}: ${(await response.text()).slice(0, 400)}`)
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
async function fsRead(sessionID, path) {
  const response = await fetch(`${BASE}/api/session/${sessionID}/fs/read/${path.split("/").map(encodeURIComponent).join("/")}`, {
    headers,
    signal: AbortSignal.timeout(timeout),
  })
  return { ok: response.status === 200, text: response.status === 200 ? await response.text() : "" }
}
async function writeFixtures(sessionID, fixtures, label) {
  const command = fixtures
    .map(({ path, content }) => {
      const encoded = Buffer.from(content, "utf8").toString("base64")
      const directory = path.slice(0, path.lastIndexOf("/"))
      return `mkdir -p ${shellQuote(directory)} && printf '%s' '${encoded}' | base64 -d > ${shellQuote(path)}`
    })
    .join(" && ")
  const stream = await prompt(sessionID, `Call the shell tool with exactly this command, changing nothing:\n\n${command}`)
  const types = stream.map((event) => event.type)
  assert(types.includes("session.execution.succeeded"), `${label}: execution did not succeed (${types.join(",")})`)
  for (const { path, content } of fixtures) {
    const read = await fsRead(sessionID, path)
    assert(read.ok && read.text === content, `fixture content mismatch at ${path}`)
  }
}
async function createSession(title) {
  const created = status(await api("/api/session", "POST", { title: `${title}-${nonce}`, location: { directory: "/workspace" }, model }), 200, `create ${title}`)
  const id = created.data?.data?.id ?? created.data?.id
  assert(id, "session id missing")
  sessionIDs.push(id)
  return id
}
const commandsOf = async (id) => status(await api(`/api/session/${id}/commands`), 200, "list commands").data
const refreshCommands = async (id) => status(await api(`/api/session/${id}/commands/refresh`, "POST"), 200, "refresh commands").data
const agentsOf = async (id) => status(await api(`/api/session/${id}/agents`), 200, "list agents").data
const refreshAgents = async (id) => status(await api(`/api/session/${id}/agents/refresh`, "POST"), 200, "refresh agents").data
const sandboxAgent = (list, id) => list.find((item) => item.agent.id === id && item.source === "sandbox")
const userTexts = async (id) => {
  const messages = status(await api(`/api/session/${id}/message?order=asc`), 200, "messages").data
  const items = messages.data ?? messages
  return items.filter((message) => message.type === "user").map((message) => message.text ?? "")
}

try {
  const root = await createSession("scan-cmd")
  const name = `dup-${nonce}`
  const singular = `/workspace/.opencode/command/${name}.md`
  const plural = `/workspace/.opencode/commands/${name}.md`
  await writeFixtures(
    root,
    [
      { path: singular, content: `---\ndescription: singular\n---\nSINGULAR_TEMPLATE_${nonce}\n` },
      { path: plural, content: `---\ndescription: plural\n---\nPLURAL_TEMPLATE_${nonce}\n` },
    ],
    "write duplicate command fixtures",
  )

  // ---------------------------------------------------------------- SAS-CM-02 / CM-08
  const first = (await refreshCommands(root)).filter((item) => item.name === name)
  assert.equal(first.length, 1, `SAS-CM-02: duplicate name produced ${first.length} definitions`)
  const winnerSourcePath = first[0].sourcePath
  const second = (await commandsOf(root)).filter((item) => item.name === name)
  const third = (await refreshCommands(root)).filter((item) => item.name === name)
  assert.equal(second[0]?.sourcePath, winnerSourcePath, "SAS-CM-08: winner changed between reads")
  assert.equal(third[0]?.sourcePath, winnerSourcePath, "SAS-CM-08: winner changed between refreshes")
  check(true, `SAS-CM-02/08 a duplicate name collapses to one stable definition (${winnerSourcePath})`)

  // ---------------------------------------------------------------- SAS-CM-05 (sandbox over session)
  status(await api(`/api/session/${root}/commands`, "POST", { name, template: `SESSION_TEMPLATE_${nonce}` }), 200, "create session command")
  const overlaid = (await refreshCommands(root)).filter((item) => item.name === name)
  assert.equal(overlaid.length, 1, "SAS-CM-05: sandbox and session definitions did not collapse")
  assert.equal(overlaid[0].source, "sandbox", "SAS-CM-05: session command won over the sandbox definition")
  check(true, "SAS-CM-05 a sandbox command wins over a Session command with the same name")

  // Execution uses the winning template (SAS-CM-05/08 execution side).
  const winning = overlaid[0].template.trim()
  status(await api(`/api/session/${root}/command`, "POST", { name, text: "", delivery: "queue" }), 204, "execute command")
  let texts = []
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    texts = await userTexts(root)
    if (texts.includes(winning)) break
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  assert(
    texts.includes(winning),
    `SAS-CM-05: executed template not found in user messages (${JSON.stringify(texts.map((text) => text.slice(0, 40)))})`,
  )
  check(true, "SAS-CM-05/08 execution expands the winning sandbox template")
  status(await api(`/api/experimental/session/${root}/wait`, "POST"), 204, "wait for command turn")

  // ---------------------------------------------------------------- SAS-SH-01 (subagent shares root sandbox)
  const shared = `/workspace/.opencode/agents/scan-${nonce}/shared.md`
  await writeFixtures(root, [{ path: shared, content: `---\ndescription: Shared\nmode: subagent\n---\nSYSTEM_SHARED_${nonce}\n` }], "write shared fixture")
  assert(sandboxAgent(await refreshAgents(root), `scan-${nonce}/shared`), "SAS-SH-01: root did not discover the shared fixture")

  await prompt(
    root,
    'Call the subagent tool exactly once with agent "general", description "sandbox share check", background false, and prompt "Reply with the single word DONE and use no tools." Then stop immediately.',
  )
  status(await api(`/api/experimental/session/${root}/wait`, "POST"), 204, "wait for root turn")
  const sessions = status(await api("/api/session"), 200, "list sessions").data
  const child = (sessions.data ?? sessions).find((item) => item.parentID === root)
  assert(child, "SAS-SH-01: no child session was created by the subagent tool")
  sessionIDs.push(child.id)
  const childAgents = await refreshAgents(child.id)
  assert(sandboxAgent(childAgents, `scan-${nonce}/shared`), "SAS-SH-01: child did not read the root sandbox fixture")
  assert.equal(pg(`SELECT count(*) FROM session_agents WHERE session_id=${sqlQuote(child.id)}`), "0", "SAS-SH-01: scan wrote child agent rows")
  check(true, "SAS-SH-01 a subagent child session reads the root sandbox fixtures with no PostgreSQL rows")

  // ---------------------------------------------------------------- SAS-SH-03 (sandbox recreation)
  const killPath = `/workspace/.opencode/agents/scan-${nonce}/kill.md`
  await writeFixtures(root, [{ path: killPath, content: `---\ndescription: Kill\nmode: subagent\n---\nSYSTEM_KILL_${nonce}\n` }], "write kill fixture")
  assert(sandboxAgent(await refreshAgents(root), `scan-${nonce}/kill`), "SAS-SH-03: fixture not discovered before recreation")
  const killed = status(await api(`/api/session/${root}/kill-sandbox`, "POST"), 200, "kill sandbox")
  assert.equal(typeof killed.destroyed, "boolean", "SAS-SH-03: kill-sandbox response missing destroyed")
  const after = await refreshAgents(root)
  const stillListed = Boolean(sandboxAgent(after, `scan-${nonce}/kill`))
  // The next scan recreates the sandbox; the cache must agree with what is actually on disk.
  const onDisk = (await fsRead(root, killPath)).ok
  assert.equal(stillListed, onDisk, `SAS-SH-03: cache disagreed with the filesystem (listed=${stillListed}, onDisk=${onDisk})`)
  check(true, `SAS-SH-03 after sandbox recreation the scan agrees with the filesystem (file present: ${onDisk})`)
} finally {
  for (const id of sessionIDs.reverse()) await api(`/api/session/${id}`, "DELETE")
}

if (sessionIDs.length) {
  const ids = sessionIDs.map(sqlQuote).join(",")
  assert.equal(pg(`SELECT count(*) FROM session_v2 WHERE id IN (${ids})`), "0", "test Sessions remained in PostgreSQL")
  assert.equal(pg(`SELECT count(*) FROM session_agents WHERE session_id IN (${ids})`), "0", "test Agent rows remained in PostgreSQL")
  assert.equal(pg(`SELECT count(*) FROM session_commands WHERE session_id IN (${ids})`), "0", "test Command rows remained in PostgreSQL")
  check(true, "all test Session, Agent, and Command rows were removed from PostgreSQL")
}

if (passed.length) say(`\n${passed.length} command/subagent sandbox scan assertions passed.`)
