import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"

/**
 * Session sandbox definition scan (V2) — HTTP + PostgreSQL gate for
 * `docs/test-cases/session/sandbox-definition-scan.md`.
 *
 * Fixtures are written through `prompt_stream` driving the shell tool, never by docker exec or
 * direct PostgreSQL writes, so the product path (sandbox -> scan -> merge) is what gets tested.
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

// Unbuffered so a failed run still shows how far it got.
function say(line) {
  process.stdout.write(`${line}\n`)
}

function check(condition, description) {
  assert(condition, description)
  passed.push(description)
  say(`PASS: ${description}`)
}

function pg(sql) {
  if (!PG_URL) throw new Error("PG_URL is required for sandbox definition scan assertions")
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

async function events(response, label) {
  if (response.status !== 200) throw new Error(`${label} HTTP ${response.status}: ${(await response.text()).slice(0, 400)}`)
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/i)
  const output = []
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
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
        output.push(JSON.parse(data))
      } catch {}
    }
  }
  return output
}

async function prompt(sessionID, text) {
  const response = await fetch(`${BASE}/api/session/${sessionID}/prompt_stream`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text, metadata: {}, delivery: "queue" }),
    signal: AbortSignal.timeout(timeout),
  })
  return events(response, `prompt_stream ${sessionID}`)
}

async function fsRead(sessionID, path) {
  const response = await fetch(`${BASE}/api/session/${sessionID}/fs/read/${path.split("/").map(encodeURIComponent).join("/")}`, {
    headers,
    signal: AbortSignal.timeout(timeout),
  })
  assert.equal(response.status, 200, `read sandbox file ${path}: HTTP ${response.status}`)
  return new TextDecoder().decode(await response.arrayBuffer())
}

/** Runs one shell command in the owning Session sandbox through the product's tool path. */
async function shell(sessionID, command, label = command.slice(0, 60)) {
  const stream = await prompt(sessionID, `Call the shell tool with exactly this command, changing nothing:\n\n${command}`)
  const types = stream.map((event) => event.type)
  assert(types.includes("session.execution.succeeded"), `${label}: execution did not succeed (${types.join(",")})`)
  assert(!types.includes("session.execution.failed"), `${label}: execution failed`)
  return stream
}

async function writeFixture(sessionID, path, content, options = {}) {
  await writeFixtures(sessionID, [{ path, content, ...options }], `write ${path}`)
}

/** Writes several fixtures in one product turn to keep model round trips low. */
async function writeFixtures(sessionID, fixtures, label) {
  const command = fixtures
    .map(({ path, content, mtimeEpoch }) => {
      const encoded = Buffer.from(content, "utf8").toString("base64")
      const directory = path.slice(0, path.lastIndexOf("/"))
      const suffix = mtimeEpoch === undefined ? "" : ` && touch -d '@${mtimeEpoch}' ${shellQuote(path)}`
      return `mkdir -p ${shellQuote(directory)} && printf '%s' '${encoded}' | base64 -d > ${shellQuote(path)}${suffix}`
    })
    .join(" && ")
  await shell(sessionID, command, label)
  for (const { path, content } of fixtures) {
    assert.equal(await fsRead(sessionID, path), content, `fixture content mismatch at ${path}`)
  }
}

async function removeFixtures(sessionID, paths, label) {
  await shell(sessionID, paths.map((path) => `rm -f ${shellQuote(path)}`).join(" && "), label)
  for (const path of paths) {
    const response = await fetch(`${BASE}/api/session/${sessionID}/fs/read/${path.split("/").map(encodeURIComponent).join("/")}`, {
      headers,
      signal: AbortSignal.timeout(timeout),
    })
    assert.notEqual(response.status, 200, `removed fixture still readable at ${path}`)
  }
}

async function createSession(title) {
  const created = status(
    await api("/api/session", "POST", { title: `${title}-${nonce}`, location: { directory: "/workspace" }, model }),
    200,
    `create session ${title}`,
  )
  const id = created.data?.data?.id ?? created.data?.id
  assert(id, `session id missing: ${created.text}`)
  sessionIDs.push(id)
  return id
}

const agentsOf = async (sessionID) => status(await api(`/api/session/${sessionID}/agents`), 200, "list agents").data
const commandsOf = async (sessionID) => status(await api(`/api/session/${sessionID}/commands`), 200, "list commands").data
const refreshAgents = async (sessionID) => status(await api(`/api/session/${sessionID}/agents/refresh`, "POST"), 200, "refresh agents").data
const refreshCommands = async (sessionID) => status(await api(`/api/session/${sessionID}/commands/refresh`, "POST"), 200, "refresh commands").data
const sandboxAgent = (list, id) => list.find((item) => item.agent.id === id && item.source === "sandbox")

const agentBody = (description, system) => `---\ndescription: ${description}\nmode: subagent\n---\n${system}\n`

try {
  const root = await createSession("scan-root")
  const other = await createSession("scan-other")

  // ---------------------------------------------------------------- SAS-AG-01 / AG-02
  const agentDir = `/workspace/.opencode/agents/scan-${nonce}`
  const reviewerPath = `${agentDir}/reviewer.md`
  const singularPath = `/workspace/.opencode/agent/singular-${nonce}.md`
  await writeFixtures(
    root,
    [
      { path: reviewerPath, content: agentBody("Sandbox reviewer", `SYSTEM_AG01_${nonce}`) },
      { path: singularPath, content: agentBody("Singular", `SYSTEM_SINGULAR_${nonce}`) },
    ],
    "write initial agent fixtures",
  )

  const pgAgentsBefore = pg(`SELECT count(*) FROM session_agents WHERE session_id=${sqlQuote(root)}`)
  const refreshed = await refreshAgents(root)
  const reviewer = sandboxAgent(refreshed, `scan-${nonce}/reviewer`)
  assert(reviewer, `SAS-AG-01: sandbox agent not discovered: ${JSON.stringify(refreshed.map((i) => i.agent.id))}`)
  assert.equal(reviewer.sourcePath, `scan-${nonce}/reviewer.md`)
  assert.equal(reviewer.agent.system, `SYSTEM_AG01_${nonce}`)
  assert.equal(reviewer.agent.mode, "subagent")
  check(true, "SAS-AG-01 refresh discovers a sandbox Agent with id/source/sourcePath/system")
  assert(sandboxAgent(refreshed, `singular-${nonce}`), "SAS-AG-02: singular .opencode/agent directory was not scanned")
  check(true, "SAS-AG-02 both singular agent/ and plural agents/ roots are discovered")
  assert.equal(pg(`SELECT count(*) FROM session_agents WHERE session_id=${sqlQuote(root)}`), pgAgentsBefore)
  check(true, "SAS-AG-01/02 scanned sandbox definitions wrote no session_agents rows")

  // ---------------------------------------------------------------- SAS-AG-03 (cache vs directory snapshot)
  await writeFixture(root, reviewerPath, agentBody("Sandbox reviewer v2", `SYSTEM_AG03_${nonce}`))
  const direct = sandboxAgent(await agentsOf(root), `scan-${nonce}/reviewer`)
  assert.equal(direct?.agent.system, `SYSTEM_AG03_${nonce}`, "SAS-AG-03: plain list returned a stale definition")
  const afterRefresh = sandboxAgent(await refreshAgents(root), `scan-${nonce}/reviewer`)
  assert.equal(afterRefresh?.agent.system, `SYSTEM_AG03_${nonce}`)
  check(true, "SAS-AG-03 plain GET sees the change without refresh and matches refresh")

  // ---------------------------------------------------------------- SAS-AG-04
  const addedPath = `${agentDir}/added.md`
  await writeFixture(root, addedPath, agentBody("Added", `SYSTEM_AG04_${nonce}`))
  const withAdded = await agentsOf(root)
  assert(sandboxAgent(withAdded, `scan-${nonce}/added`), "SAS-AG-04: newly added definition missing")
  assert(sandboxAgent(withAdded, `scan-${nonce}/reviewer`), "SAS-AG-04: existing definition dropped")
  check(true, "SAS-AG-04 a new file appears on the next list and the old id is retained")

  // ---------------------------------------------------------------- SAS-AG-06 / AG-07
  const malformedPath = `${agentDir}/malformed.md`
  const otherRootPath = `/workspace/.opencode/other/ignored-${nonce}.md`
  const notMarkdownPath = `${agentDir}/notes-${nonce}.txt`
  // Resolves to `/workspace/.opencode/escaped-<nonce>.md`, i.e. above the discovery root.
  const escapedPath = `/workspace/.opencode/agents/../escaped-${nonce}.md`
  await writeFixtures(
    root,
    [
      { path: malformedPath, content: "---\nmode: impossible\n---\nnot a valid agent\n" },
      { path: otherRootPath, content: agentBody("Ignored", "SYSTEM_OTHER") },
      { path: notMarkdownPath, content: agentBody("NotMarkdown", "SYSTEM_TXT") },
      { path: escapedPath, content: agentBody("Escaped", "SYSTEM_ESC") },
    ],
    "write out-of-scope fixtures",
  )

  const guarded = await refreshAgents(root)
  assert(sandboxAgent(guarded, `scan-${nonce}/reviewer`), "SAS-AG-06: valid definition lost next to a malformed file")
  assert(sandboxAgent(guarded, `scan-${nonce}/added`), "SAS-AG-06: valid definition lost next to malformed files")
  assert.equal(sandboxAgent(guarded, `escaped-${nonce}`), undefined, "SAS-AG-07: definition above the discovery root became visible")
  assert.equal(sandboxAgent(guarded, `ignored-${nonce}`), undefined, "SAS-AG-07: definition outside discovery roots became visible")
  assert(!guarded.some((item) => item.source === "sandbox" && item.agent.id.includes("notes-")), "SAS-AG-07: non-markdown file became visible")
  check(true, "SAS-AG-06/07 malformed and out-of-scope files are skipped without dropping valid definitions")

  // ---------------------------------------------------------------- SAS-AG-10 (sandbox over session)
  const overrideID = `scan-${nonce}/override`
  status(
    await api(`/api/session/${root}/agents`, "POST", {
      id: overrideID,
      config: { mode: "subagent", description: "SESSION_ONLY_DESCRIPTION", system: `SYSTEM_SESSION_${nonce}` },
    }),
    200,
    "create session override",
  )
  // The markdown body is the Agent system prompt; frontmatter `system` is overwritten by it.
  // `description` is deliberately absent so the Session-only field must survive the overlay.
  await writeFixture(root, `${agentDir}/override.md`, `---\nmode: subagent\n---\nSYSTEM_SANDBOX_${nonce}\n`)
  const merged = sandboxAgent(await refreshAgents(root), overrideID)
  assert.equal(merged?.agent.system, `SYSTEM_SANDBOX_${nonce}`, "SAS-AG-10: sandbox system did not win")
  assert.equal(merged?.agent.description, "SESSION_ONLY_DESCRIPTION", "SAS-AG-10: untouched session field was not retained")
  await removeFixtures(root, [`${agentDir}/override.md`], "remove override fixture")
  const restored = await refreshAgents(root)
  const restoredEntry = restored.find((item) => item.agent.id === overrideID)
  assert.equal(restoredEntry?.agent.system, `SYSTEM_SESSION_${nonce}`, "SAS-AG-10: session value did not return after removing the sandbox file")
  check(true, "SAS-AG-10 sandbox fields override session fields and removal restores session values")

  // ---------------------------------------------------------------- SAS-AG-05
  await removeFixtures(root, [reviewerPath], "remove reviewer fixture")
  const afterRemove = await refreshAgents(root)
  assert.equal(sandboxAgent(afterRemove, `scan-${nonce}/reviewer`), undefined, "SAS-AG-05: removed definition still listed")
  assert.equal(pg(`SELECT count(*) FROM session_agents WHERE session_id=${sqlQuote(root)} AND agent_id=${sqlQuote(`scan-${nonce}/reviewer`)}`), "0")
  check(true, "SAS-AG-05 a deleted file disappears after refresh with no PostgreSQL residue")

  // ---------------------------------------------------------------- SAS-CM-01 / CM-03
  const commandDir = `/workspace/.opencode/commands/scan-${nonce}`
  const helloPath = `${commandDir}/hello.md`
  const commandsBefore = pg(`SELECT count(*) FROM session_commands WHERE session_id=${sqlQuote(root)}`)
  await writeFixture(root, helloPath, `---\ndescription: Sandbox hello\n---\nSay $ARGUMENTS\n`)
  const hello = (await refreshCommands(root)).find((item) => item.name === `scan-${nonce}/hello` && item.source === "sandbox")
  assert(hello, "SAS-CM-01: sandbox command not discovered")
  assert.equal(hello.sourcePath, `scan-${nonce}/hello.md`)
  assert.equal(hello.template, "Say $ARGUMENTS")
  assert.equal(pg(`SELECT count(*) FROM session_commands WHERE session_id=${sqlQuote(root)}`), commandsBefore)
  check(true, "SAS-CM-01 refresh discovers a sandbox command and writes no session_commands row")

  await writeFixture(root, helloPath, `---\ndescription: Sandbox hello v2\n---\nEcho $1 $2\n`)
  const updated = (await commandsOf(root)).find((item) => item.name === `scan-${nonce}/hello`)
  assert.equal(updated?.template, "Echo $1 $2", "SAS-CM-03: plain list returned a stale template")
  await removeFixtures(root, [helloPath], "remove command fixture")
  assert.equal((await refreshCommands(root)).find((item) => item.name === `scan-${nonce}/hello`), undefined, "SAS-CM-03: removed command still listed")
  check(true, "SAS-CM-03 command template changes and deletions are reflected on the next read")

  // ---------------------------------------------------------------- SAS-CACHE-01 / CACHE-07
  const pinnedEpoch = 1_000_000_000
  const cachePath = `${agentDir}/cache-${nonce}.md`
  await writeFixture(root, cachePath, agentBody("Pinned", `CACHE_OLD_${nonce}`), { mtimeEpoch: pinnedEpoch })
  const firstRead = sandboxAgent(await refreshAgents(root), `scan-${nonce}/cache-${nonce}`)
  assert.equal(firstRead?.agent.system, `CACHE_OLD_${nonce}`)
  // Same byte length so size is unchanged; the explicit mtime keeps the fingerprint identical.
  const replacement = `CACHE_NEW_${nonce}`.padEnd(`CACHE_OLD_${nonce}`.length, "_")
  await writeFixture(root, cachePath, agentBody("Pinned", replacement), { mtimeEpoch: pinnedEpoch })
  const forced = sandboxAgent(await refreshAgents(root), `scan-${nonce}/cache-${nonce}`)
  assert.equal(forced?.agent.system, replacement, "SAS-CACHE-01/07: forced refresh did not read the new content")
  check(true, "SAS-CACHE-01/07 force refresh re-reads a file whose mtime:size fingerprint is unchanged")

  // ---------------------------------------------------------------- SAS-LIFE-01 / LIFE-02
  const lifeRoot = await createSession("scan-life")
  assert.equal((await refreshAgents(lifeRoot)).some((item) => item.source === "sandbox"), false, "SAS-LIFE-01: unexpected sandbox agent before any directory exists")
  await writeFixture(lifeRoot, `/workspace/.opencode/agents/life-${nonce}/created.md`, agentBody("Created", `SYSTEM_LIFE_${nonce}`))
  assert(sandboxAgent(await refreshAgents(lifeRoot), `life-${nonce}/created`), "SAS-LIFE-01: definition in a freshly created directory was not discovered")
  check(true, "SAS-LIFE-01 a directory created after an empty scan is picked up by the next scan")

  await shell(lifeRoot, `mkdir -p /workspace/.opencode/agent && mv ${shellQuote(`/workspace/.opencode/agents/life-${nonce}/created.md`)} ${shellQuote(`/workspace/.opencode/agent/moved-${nonce}.md`)}`, "move agent fixture")
  const moved = await refreshAgents(lifeRoot)
  assert.equal(sandboxAgent(moved, `life-${nonce}/created`), undefined, "SAS-LIFE-02: old sourcePath survived the move")
  assert(sandboxAgent(moved, `moved-${nonce}`), "SAS-LIFE-02: moved definition was not discovered")
  check(true, "SAS-LIFE-02 moving a file between singular and plural roots updates the discovery result")

  // ---------------------------------------------------------------- SAS-SH-02 / API-01
  const otherAgents = await refreshAgents(other)
  assert.equal(sandboxAgent(otherAgents, `scan-${nonce}/added`), undefined, "SAS-SH-02: another root session saw a shared fixture")
  assert.equal(sandboxAgent(otherAgents, `scan-${nonce}/cache-${nonce}`), undefined)
  check(true, "SAS-SH-02 sandbox definitions stay isolated to their owning root session")

  assert.equal((await api("/api/session/ses_missing_scan/agents")).response.status, 404)
  assert.equal((await api("/api/session/ses_missing_scan/agents/refresh", "POST")).response.status, 404)
  assert.equal((await api("/api/session/ses_missing_scan/commands")).response.status, 404)
  check(true, "SAS-API-01 unknown Session agent/command list and refresh return 404")
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

if (passed.length) console.log(`\n${passed.length} sandbox definition scan assertions passed.`)
