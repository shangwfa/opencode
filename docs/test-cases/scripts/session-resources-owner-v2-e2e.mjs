import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"

const base = (process.env.BASE ?? "http://127.0.0.1:14296").replace(/\/$/, "")
const pgURL = process.env.PG_URL ?? "postgresql://local@127.0.0.1:5432/opencode-v2-test"
const nonce = randomUUID().replaceAll("-", "").slice(0, 10)
const model = JSON.parse(process.env.MODEL ?? '{"providerID":"Yd-DeepSeek","id":"deepseek-v4-flash"}')
const headers = {
  "content-type": "application/json",
  ...(process.env.OPENCODE_PASSWORD
    ? { authorization: `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString("base64")}` }
    : {}),
}
const names = {
  agent: `owner-agent-${nonce}`,
  skill: `owner-skill-${nonce}`,
  mcp: `owner-mcp-${nonce}`,
  tool: `owner-tool-${nonce}`,
  command: `owner-command-${nonce}`,
}
let root
let child
const checks = []
const evidence = {}
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`
function pg(sql) {
  const result = spawnSync("psql", [pgURL, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    encoding: "utf8",
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
function check(condition, description) {
  assert(condition, description)
  checks.push(description)
  console.log(`PASS ${description}`)
}
async function api(path, method = "GET", body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(180_000),
  })
  const text = await response.text()
  assert(response.ok, `${method} ${path}: ${response.status} ${text.slice(0, 500)}`)
  return text ? JSON.parse(text) : undefined
}
async function runShell(id, command) {
  await api(`/api/session/${id}/shell`, "POST", { command })
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const messages = (await api(`/api/session/${id}/message?order=asc&limit=200`)).data
    const shell = messages.filter((message) => message.type === "shell" && message.command === command).at(-1)
    if (shell && shell.status !== "running") {
      assert.equal(shell.status, "exited", JSON.stringify(shell))
      assert.equal(shell.exit, 0, JSON.stringify(shell))
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error("Sandbox fixture shell timed out")
}
const toolCode = (value) =>
  `import {tool} from "@opencode-ai/plugin";export default tool({description:"Return the shared resource marker",args:{},async execute(){const fs=await import("node:fs/promises");await fs.writeFile("/workspace/owner-${nonce}.txt",${JSON.stringify(value)});return ${JSON.stringify(value)}}})`
async function write(id, value) {
  await api(`/api/session/${id}/agents`, "POST", {
    id: names.agent,
    config: {
      mode: "subagent",
      system: `Call ${names.tool} exactly once then stop. Do not use other tools.`,
      description: value,
    },
  })
  await api(`/api/session/${id}/skills`, "POST", {
    id: names.skill,
    description: value,
    content: value,
    resources: [{ path: "references/guide.md", type: "doc", content: value }],
  })
  await api(`/api/session/${id}/mcps`, "POST", {
    name: names.mcp,
    config: { type: "remote", url: `http://127.0.0.1/${value}`, oauth: false, disabled: true },
  })
  await api(`/api/session/${id}/tools`, "POST", { name: names.tool, description: value, code: toolCode(value) })
  await api(`/api/session/${id}/commands`, "POST", { name: names.command, template: value })
  await api(`/api/session/${id}/agents-md`, "POST", { content: `RESOURCE_OWNER_INSTRUCTION_${value}` })
}
async function read(id, value) {
  const agent = (await api(`/api/session/${id}/agents`)).data.find((item) => item.agent.id === names.agent)
  const skill = (await api(`/api/session/${id}/skills`)).data.find((item) => item.skill.id === names.skill)
  const mcp = (await api(`/api/session/${id}/mcps`)).data.find((item) => item.name === names.mcp)
  const tool = (await api(`/api/session/${id}/tools`)).data.find((item) => item.name === names.tool)
  const command = (await api(`/api/session/${id}/commands`)).data.find((item) => item.name === names.command)
  const md = (await api(`/api/session/${id}/agents-md`)).data
  check(
    agent?.agent.description === value &&
      skill?.skill.content === value &&
      mcp?.config.url.endsWith(`/${value}`) &&
      tool?.description === value &&
      command?.template === value &&
      md?.content === `RESOURCE_OWNER_INSTRUCTION_${value}` &&
      md?.sessionID === root,
    `six resources resolve to the shared root: ${value}`,
  )
}
async function run(id, value) {
  const response = await fetch(`${base}/api/session/${id}/prompt_stream`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      text: `必须调用 ${names.tool} 一次，然后停止。`,
      skills: [{ id: names.skill }],
      metadata: {},
      delivery: "queue",
    }),
    signal: AbortSignal.timeout(180_000),
  })
  const stream = await response.text()
  assert(response.ok, stream.slice(0, 500))
  const messages = (await api(`/api/session/${id}/message?order=asc&limit=200`)).data
  const calls = messages
    .filter((message) => message.type === "assistant")
    .flatMap((message) => message.content ?? [])
    .filter((part) => part.type === "tool" && part.name === names.tool)
  check(
    calls.some((call) => call.state.status === "completed" && JSON.stringify(call.state.content).includes(value)),
    `child executes the root tool version ${value}`,
  )
  const path = `owner-${nonce}.txt`
  const file = await fetch(`${base}/api/session/${root}/fs/read/${path}`, {
    headers,
    signal: AbortSignal.timeout(30_000),
  })
  assert(file.ok, `read shared Sandbox artifact: ${file.status}`)
  check((await file.text()) === value, `root observes the child Sandbox side effect ${value}`)
  const digest = (text) => createHash("sha256").update(text).digest("hex")
  const bundle = digest(JSON.stringify({ content: value, resources: [["references/guide.md", digest(value)]] }))
  const resource = await fetch(
    `${base}/api/session/${root}/fs/read/.opencode/.session-skills/${root}/${bundle}/references/guide.md`,
    { headers, signal: AbortSignal.timeout(30_000) },
  )
  assert(resource.ok, `read materialized shared Skill resource: ${resource.status}`)
  check((await resource.text()) === value, `child materializes the root Skill resource bundle ${value}`)
}
try {
  root = (
    await api("/api/session", "POST", {
      title: `resource-owner-e2e-${nonce}`,
      location: { directory: "/workspace" },
      model,
    })
  ).data.id
  await write(root, "VERSION_1")
  await api(`/api/session/${root}/commands`, "POST", {
    name: `spawn-${nonce}`,
    description: `owner-child-${nonce}`,
    template: `Call ${names.tool} exactly once, then stop.`,
    agent: names.agent,
    model: `${model.providerID}/${model.id}`,
    subagent: true,
  })
  await api(`/api/session/${root}/command`, "POST", { name: `spawn-${nonce}`, text: "" })
  child = pg(
    `select id from session_v2 where parent_id=${quote(root)} and title=${quote(`owner-child-${nonce}`)} order by time_created desc limit 1`,
  )
  assert(child, "command did not create an internal child")
  await api(`/api/experimental/session/${child}/wait`, "POST")
  evidence.root = root
  evidence.child = child
  await read(child, "VERSION_1")
  const projectSkillPath = `/workspace/.opencode/skills/${names.skill}/SKILL.md`
  const projectSkill = Buffer.from(
    `---\nname: ${names.skill}\ndescription: Sandbox priority marker\n---\nSANDBOX_SKILL_PRIORITY`,
  ).toString("base64")
  await runShell(
    root,
    `mkdir -p '/workspace/.opencode/skills/${names.skill}'; printf '%s' '${projectSkill}' | base64 -d > '${projectSkillPath}'`,
  )
  const projectSkills = (await api(`/api/session/${child}/skills/refresh`, "POST")).data
  check(
    projectSkills.some(
      (item) =>
        item.skill.id === names.skill &&
        item.source === "sandbox" &&
        item.skill.content.includes("SANDBOX_SKILL_PRIORITY"),
    ),
    "Sandbox Skill overrides the shared Session Skill",
  )
  await runShell(root, `rm '${projectSkillPath}'`)
  const fallbackSkills = (await api(`/api/session/${child}/skills/refresh`, "POST")).data
  check(
    fallbackSkills.some(
      (item) => item.skill.id === names.skill && item.source === "session" && item.skill.content === "VERSION_1",
    ),
    "removing Sandbox Skill restores the shared Session Skill",
  )
  await write(root, "VERSION_2")
  await read(child, "VERSION_2")
  await run(child, "VERSION_2")
  await write(child, "VERSION_3")
  await read(root, "VERSION_3")
  await run(child, "VERSION_3")
  for (const table of [
    "session_agents",
    "session_skills",
    "session_mcps",
    "session_tools",
    "session_commands",
    "session_agents_md",
  ]) {
    check(
      pg(`select count(*) from ${table} where session_id=${quote(child)}`) === "0",
      `${table} has no copied/private child rows`,
    )
  }
  if (process.env.MODEL_REQUEST_LOG_FILE) {
    const text = await fs.readFile(process.env.MODEL_REQUEST_LOG_FILE, "utf8")
    const requests = text
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse)
      .filter((row) => row.sessionID === child && row.kind === "primary")
    check(
      requests.some(
        (row) =>
          !row.truncated &&
          JSON.stringify({ system: row.system, messages: row.messages }).includes(
            "RESOURCE_OWNER_INSTRUCTION_VERSION_3",
          ),
      ),
      "child model request receives the current root AGENTS.md",
    )
    check(
      requests.some((row) => row.toolNames?.includes("execute") && row.toolNames?.includes(names.tool)),
      "Code Mode remains enabled alongside the shared native tool",
    )
  }
  await api(`/api/session/${child}`, "DELETE")
  await read(root, "VERSION_3")
  check(
    pg(`select count(*) from session_v2 where id=${quote(child)}`) === "0",
    "child deletion does not delete shared root definitions",
  )
  await api(`/api/session/${root}/agents/${names.agent}`, "DELETE")
  await api(`/api/session/${root}/skills/${names.skill}`, "DELETE")
  await api(`/api/session/${root}/mcps/${names.mcp}`, "DELETE")
  await api(`/api/session/${root}/tools/${names.tool}`, "DELETE")
  await api(`/api/session/${root}/commands/${names.command}`, "DELETE")
  await api(`/api/session/${root}/agents-md`, "DELETE")
  check((await api(`/api/session/${root}/tools`)).data.length === 0, "shared tool deletion is reflected by the API")
} catch (error) {
  evidence.error = error instanceof Error ? error.stack : String(error)
  console.error(evidence.error)
  process.exitCode = 1
} finally {
  if (root) {
    try {
      await api(`/api/session/${root}`, "DELETE")
      for (const table of [
        "session_v2",
        "session_agents",
        "session_skills",
        "session_mcps",
        "session_tools",
        "session_commands",
        "session_agents_md",
      ]) {
        const column = table === "session_v2" ? "id" : "session_id"
        check(
          pg(`select count(*) from ${table} where ${column} in (${quote(root)},${quote(child ?? root)})`) === "0",
          `${table} cleaned after the test`,
        )
      }
    } catch (error) {
      evidence.cleanupError = String(error)
      console.error(evidence.cleanupError)
      process.exitCode = 1
    }
  }
  if (process.env.REPORT)
    await fs.writeFile(
      process.env.REPORT,
      JSON.stringify({ checks, evidence, passed: checks.length, failed: process.exitCode ? 1 : 0 }, null, 2),
    )
  console.log(`resource owner E2E: ${checks.length} passed, ${process.exitCode ? 1 : 0} failed`)
}
