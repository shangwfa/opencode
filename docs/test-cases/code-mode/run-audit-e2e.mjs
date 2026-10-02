#!/usr/bin/env node
// Deterministic Code Mode audit E2E: drives the V2 HTTP API for one Session and
// asserts against the model-request audit log plus optional PostgreSQL checks.
//
// The audit assertions are the point of this script. A PASS here means the
// provider request itself was inspected, not just the Session's stored messages.
//
//   BASE=http://127.0.0.1:14096 \
//   OPENCODE_PASSWORD=... \
//   MODEL_PROVIDER=Yd-DeepSeek MODEL_ID=deepseek-v4-flash \
//   FIXTURE=workitems-large-mcp.mjs \
//   PROMPTS='["prompt one","prompt two"]' \
//   AUDIT_DIR=/tmp/codemode-audit \
//   node run-audit-e2e.mjs
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { basename, resolve } from "node:path"

const base = process.env.BASE ?? "http://127.0.0.1:14096"
const password = process.env.OPENCODE_PASSWORD
if (!password) throw new Error("OPENCODE_PASSWORD is required")
const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
const model = { providerID: process.env.MODEL_PROVIDER ?? "Yd-DeepSeek", id: process.env.MODEL_ID ?? "deepseek-v4-flash" }
const fixture = process.env.FIXTURE ?? "workitems-large-mcp.mjs"
const mcpName = process.env.MCP_NAME ?? basename(fixture, "-mcp.mjs")
const prompts = JSON.parse(process.env.PROMPTS ?? '[""]')
const auditDir = process.env.AUDIT_DIR ?? ""
const sentinel = process.env.SENTINEL ?? ""
const absentInRequest = (process.env.ABSENT ?? "").split(",").filter(Boolean)
const expectedTool = process.env.EXPECT_TOOL ?? "execute"
const forbiddenToolPrefix = process.env.FORBIDDEN_TOOL_PREFIX ?? ""
const extraToolPrefix = process.env.EXPECT_FORBIDDEN_PREFIX ?? ""
/** Model-request kinds that carry the agent tool catalog. A title request has none. */
const agentKinds = (process.env.AGENT_KINDS ?? "primary,generate,compaction").split(",")
const expectCatalogTotal = Number(process.env.EXPECT_CATALOG_TOTAL ?? 0)
const maxSeconds = Number(process.env.MAX_SECONDS ?? 240)

const root = resolve(import.meta.dirname, "fixtures")
const failures = []
const check = (ok, message) => {
  if (!ok) failures.push(message)
  console.log(`${ok ? "PASS" : "FAIL"} ${message}`)
}

async function request(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { authorization, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${text.slice(0, 400)}`)
  return text ? JSON.parse(text) : undefined
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForAssistant(sessionID, seen) {
  const deadline = Date.now() + maxSeconds * 1000
  while (Date.now() < deadline) {
    const messages = (await request("GET", `/api/session/${sessionID}/message`)).data ?? []
    const fresh = messages.filter((message) => {
      if (seen.has(message.id)) return false
      if ((message.type ?? message.role) !== "assistant") return false
      return (message.time?.completed ?? message.time?.end) !== undefined
    })
    if (fresh.length > 0) return messages
    await sleep(1000)
  }
  throw new Error("assistant turn did not complete before the deadline")
}

const pgval = (statement) =>
  execFileSync("psql", ["-h", "127.0.0.1", "-p", "5432", "-U", "local", "-d", "opencode-v2-up", "-At", "-c", statement], {
    encoding: "utf8",
  }).trim()

const session = (await request("POST", "/api/session", { model })).data
const sessionID = session.id
console.log(`session ${sessionID}`)
try {
  const encoded = Buffer.from(readFileSync(resolve(root, fixture))).toString("base64")
  const path = `/workspace/docs/test-cases/code-mode/fixtures/${fixture}`
  await request("POST", `/api/session/${sessionID}/shell`, {
    command: `mkdir -p /workspace/docs/test-cases/code-mode/fixtures && printf '%s' '${encoded}' | base64 -d > '${path}' && node --check '${path}'`,
  })
  await request("POST", `/api/session/${sessionID}/mcps`, {
    name: mcpName,
    config: { type: "local", command: ["node", path] },
  })

  const turns = []
  for (const prompt of prompts) {
    // Wait per turn: a new completed assistant message must appear after this
    // submission, otherwise the next prompt races the previous turn.
    const seen = new Set(((await request("GET", `/api/session/${sessionID}/message`)).data ?? []).map((m) => m.id))
    await request("POST", `/api/session/${sessionID}/prompt`, { text: prompt })
    await waitForAssistant(sessionID, seen)
    turns.push(prompt)
  }

  // jsonb_path_query is set-returning, so aggregate it in SQL to keep one psql row.
  const rows = pgval(
    `SELECT coalesce(jsonb_agg(part), '[]'::jsonb) FROM (SELECT jsonb_path_query(data::jsonb, '$.content[*] ? (@.type == "tool" && @.name == "execute")') AS part FROM session_message WHERE session_id='${sessionID}' AND type='assistant') AS found`,
  )
  const parts = JSON.parse(rows).map((part) => part.state)
  check(parts.length > 0, `execute ran ${parts.length} time(s)`)
  check(
    parts.every((state) => state.status === "completed"),
    "every execute reached completed",
  )

  const logPath = resolve(auditDir, "model-requests.jsonl")
  if (!auditDir || !existsSync(logPath)) throw new Error(`no model request audit at ${logPath}`)
  const entries = readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.sessionID === sessionID)
  const agent = entries.filter((entry) => agentKinds.includes(entry.kind))
  check(entries.length >= prompts.length, `audited ${entries.length} model request(s) for this session`)
  check(agent.length > 0, `${agent.length} agent-turn request(s) carried a tool catalog`)
  check(
    entries.every((entry) => entry.truncated === false),
    "no audited request was truncated",
  )
  check(
    agent.every((entry) => entry.toolNames.includes(expectedTool)),
    `every agent turn exposes the ${expectedTool} tool to the provider`,
  )
  for (const marker of absentInRequest)
    check(
      entries.every((entry) => JSON.stringify(entry).includes(marker) === false),
      `no model request contains ${marker}`,
    )
  if (forbiddenToolPrefix)
    check(
      agent.every((entry) => entry.toolNames.every((name) => name.startsWith(forbiddenToolPrefix) === false)),
      `no model request declares ${forbiddenToolPrefix}* as a native tool schema`,
    )
  if (extraToolPrefix)
    check(
      entries.some((entry) => entry.toolNames.some((name) => name.startsWith(extraToolPrefix))),
      `a model request discovered ${extraToolPrefix}* through Code Mode search`,
    )
  // The catalog must stay a bounded summary: namespaces report their true size
  // while inlining only what the inline budget allows.
  const catalog = [...agent.map((entry) => JSON.stringify(entry.system)).join("\n").matchAll(/- ([\w.-]+) \((\d+) tools?, (\d+) shown\)/g)]
    .map((match) => ({ namespace: match[1], total: Number(match[2]), shown: Number(match[3]) }))
  if (catalog.length > 0) {
    console.log(`catalog: ${[...new Set(catalog.map((entry) => `${entry.namespace} ${entry.shown}/${entry.total}`))].join(" | ")}`)
    check(
      catalog.every((entry) => entry.shown > 0 && entry.shown < entry.total),
      "every namespace inlines fewer tools than it lists",
    )
    if (expectCatalogTotal > 0)
      check(
        catalog.some((entry) => entry.total === expectCatalogTotal && entry.shown < expectCatalogTotal),
        `catalog lists ${expectCatalogTotal} tools and inlines fewer than all of them`,
      )
  } else if (expectCatalogTotal > 0) {
    check(false, "expected a bounded catalog summary in the system prompt")
  }
  if (sentinel)
    check(
      entries.every((entry) => JSON.stringify(entry.messages).includes(sentinel) === false),
      `no model request message contains ${sentinel}`,
    )
  // Guard against a vacuous audit: the last submitted prompt must really be
  // inside an audited request, so "content absent" is not just "request missing".
  const lastPrompt = prompts.at(-1)
  check(
    entries.some((entry) => JSON.stringify(entry.messages).includes(lastPrompt.slice(0, 12))),
    `the final prompt reached the provider (${prompts.length} turn(s) audited)`,
  )
  if (sentinel)
    check(
      pgval(`SELECT count(*) FROM session_message WHERE session_id='${sessionID}' AND data LIKE '%${sentinel}%'`) === "0",
      `stored Session messages never contain ${sentinel}`,
    )
} finally {
  await request("DELETE", `/api/session/${sessionID}`).catch(() => undefined)
  console.log(`session ${sessionID} deleted`)
}

if (failures.length > 0) {
  console.error(`\n${failures.length} assertion(s) failed`)
  process.exit(1)
}
